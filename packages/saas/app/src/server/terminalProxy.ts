import type { Server as HttpServer, IncomingMessage } from "http";
import type { Duplex } from "stream";
import type { Application } from "express";
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

export function registerTerminalStatusRoute(app: Application): void {
  app.get("/api/terminal-status", async (req, res) => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      const cookieNames = Object.keys(cookies);
      const sessionUser = await getUserFromSessionCookie(req as unknown as IncomingMessage);
      if (!sessionUser) {
        res.status(401).json({ ok: false, error: "not_authenticated", message: "No valid session", debug: { cookieNames, hasAuthSession: !!cookies["auth_session"] } });
        return;
      }

      const instance = await prisma.instance.findUnique({
        where: { userId: sessionUser.userId },
      });

      if (!instance) {
        res.json({ ok: false, error: "no_instance", message: "No instance found" });
        return;
      }

      if (instance.status !== "running") {
        res.json({ ok: false, error: "not_running", message: `Instance is ${instance.status}` });
        return;
      }

      if (!instance.tailscaleHostname || !instance.apiKey) {
        res.json({ ok: false, error: "not_ready", message: "Instance not fully provisioned", hasTailscale: !!instance.tailscaleHostname, hasApiKey: !!instance.apiKey });
        return;
      }

      res.json({ ok: true, hostname: instance.tailscaleHostname });
    } catch (err: any) {
      console.error("[terminal-status] error:", err);
      res.status(500).json({ ok: false, error: "internal", message: err.message });
    }
  });
}

export function attachTerminalProxy(server: HttpServer): void {
  console.log("[terminal-proxy] attachTerminalProxy called, registering upgrade handler");
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/api/terminal") return;

    console.log("[terminal-proxy] upgrade request received for /api/terminal");

    try {
      const sessionUser = await getUserFromSessionCookie(req);
      if (!sessionUser) {
        console.log("[terminal-proxy] auth failed: no valid session cookie");
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      console.log("[terminal-proxy] auth OK, userId:", sessionUser.userId);

      const instance = await prisma.instance.findUnique({
        where: { userId: sessionUser.userId },
      });

      if (!instance || instance.status !== "running" || !instance.tailscaleHostname || !instance.apiKey) {
        console.log("[terminal-proxy] instance check failed:", {
          found: !!instance,
          status: instance?.status,
          hasTailscale: !!instance?.tailscaleHostname,
          hasApiKey: !!instance?.apiKey,
        });
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }

      const tenantApiKey = decryptApiKey(instance.apiKey);
      const upstreamUrl = `wss://${instance.tailscaleHostname}:3100/terminal?token=${encodeURIComponent(tenantApiKey)}`;

      console.log("[terminal-proxy] connecting upstream to", instance.tailscaleHostname + ":3100/terminal");

      wss.handleUpgrade(req, socket, head, (browserWs: InstanceType<typeof WebSocket>) => {
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
          console.log("[terminal-proxy] upstream connected");
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

        upstreamWs.on("error", (err) => {
          console.error("[terminal-proxy] upstream error:", err.message);
          cleanupBoth();
        });

        upstreamWs.on("close", (code, reason) => {
          console.log("[terminal-proxy] upstream closed:", code, reason?.toString());
          upstreamClosed = true;
          cleanupBoth();
        });

        browserWs.on("close", () => {
          console.log("[terminal-proxy] browser closed");
          browserClosed = true;
          cleanupBoth();
        });

        browserWs.on("error", () => {
          cleanupBoth();
        });
      });
    } catch (err) {
      console.error("[terminal-proxy] error:", err);
      socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      socket.destroy();
    }
  });
}
