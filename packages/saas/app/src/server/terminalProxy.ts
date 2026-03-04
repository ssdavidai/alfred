import type { Server as HttpServer, IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocketServer, WebSocket } from "ws";
import { prisma } from "wasp/server";
import { decryptApiKey } from "./tenantProxy";

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(";")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx < 0) continue;
    const key = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    cookies[key] = value;
  }
  return cookies;
}

async function getUserFromSessionCookie(
  req: IncomingMessage,
): Promise<{ userId: string } | null> {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies["auth_session"];
  if (!sessionId) return null;

  // Wasp/Lucia stores sessions in the Session table
  // Session → Auth → User
  const session = await (prisma as any).session.findUnique({
    where: { id: sessionId },
    select: {
      expiresAt: true,
      auth: {
        select: { userId: true },
      },
    },
  });

  if (!session || !session.auth) return null;
  if (new Date(session.expiresAt) < new Date()) return null;

  return { userId: session.auth.userId };
}

export function attachTerminalProxy(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/api/terminal") return;

    try {
      const sessionUser = await getUserFromSessionCookie(req);
      if (!sessionUser) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      const instance = await prisma.instance.findUnique({
        where: { userId: sessionUser.userId },
      });

      if (!instance || instance.status !== "running" || !instance.tailscaleHostname || !instance.apiKey) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }

      const tenantApiKey = decryptApiKey(instance.apiKey);
      const upstreamUrl = `wss://${instance.tailscaleHostname}:3100/terminal?token=${encodeURIComponent(tenantApiKey)}`;

      wss.handleUpgrade(req, socket, head, (browserWs) => {
        // Connect to tenant ctrl terminal
        const upstreamWs = new WebSocket(upstreamUrl, {
          rejectUnauthorized: false, // Tailscale certs are self-signed
        });

        let browserClosed = false;
        let upstreamClosed = false;

        function cleanupBoth() {
          if (!browserClosed && browserWs.readyState === WebSocket.OPEN) {
            browserWs.close();
          }
          if (!upstreamClosed && upstreamWs.readyState === WebSocket.OPEN) {
            upstreamWs.close();
          }
        }

        upstreamWs.on("open", () => {
          // Bridge browser ↔ upstream (binary passthrough)
          browserWs.on("message", (data: Buffer, isBinary: boolean) => {
            if (upstreamWs.readyState === WebSocket.OPEN) {
              upstreamWs.send(data, { binary: isBinary });
            }
          });

          upstreamWs.on("message", (data: Buffer, isBinary: boolean) => {
            if (browserWs.readyState === WebSocket.OPEN) {
              browserWs.send(data, { binary: isBinary });
            }
          });
        });

        upstreamWs.on("error", () => {
          cleanupBoth();
        });

        upstreamWs.on("close", () => {
          upstreamClosed = true;
          cleanupBoth();
        });

        browserWs.on("close", () => {
          browserClosed = true;
          cleanupBoth();
        });

        browserWs.on("error", () => {
          cleanupBoth();
        });
      });
    } catch (err) {
      console.error("Terminal proxy error:", err);
      socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      socket.destroy();
    }
  });
}
