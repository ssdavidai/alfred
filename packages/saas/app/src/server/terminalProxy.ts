import type { Server as HttpServer, IncomingMessage } from "http";
import type { Duplex } from "stream";
import type { Application, Request, Response } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { prisma } from "wasp/server";
import { getSessionAndUserFromBearerToken } from "wasp/auth/session";
import { decryptApiKey } from "./tenantProxy";

/**
 * Get user ID from a request using Wasp's Bearer token auth.
 * Works for both Express requests and raw IncomingMessage (WebSocket upgrades).
 */
async function getUserIdFromRequest(
  req: IncomingMessage,
): Promise<string | null> {
  const result = await getSessionAndUserFromBearerToken(req as any);
  if (!result) return null;
  return result.user.id;
}

export function registerTerminalStatusRoute(app: Application): void {
  app.get("/api/terminal-status", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromRequest(req as unknown as IncomingMessage);
      if (!userId) {
        res.status(401).json({ ok: false, error: "not_authenticated", message: "No valid session" });
        return;
      }

      const instance = await prisma.instance.findUnique({
        where: { userId },
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
        res.json({ ok: false, error: "not_ready", message: "Instance not fully provisioned" });
        return;
      }

      res.json({ ok: true });
    } catch (err: any) {
      console.error("[terminal-status] error:", err);
      res.status(500).json({ ok: false, error: "internal", message: err.message });
    }
  });
}

export function attachTerminalProxy(server: HttpServer): void {
  console.log("[terminal-proxy] attachTerminalProxy called");
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/api/terminal") return;

    console.log("[terminal-proxy] upgrade request received");

    try {
      // WebSocket can't send custom headers, so the client passes the
      // session token as a query parameter. Inject it as an Authorization
      // header so Wasp's getSessionAndUserFromBearerToken can read it.
      const token = url.searchParams.get("token");
      if (token) {
        req.headers.authorization = `Bearer ${token}`;
      }

      const userId = await getUserIdFromRequest(req);
      if (!userId) {
        console.log("[terminal-proxy] auth failed");
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      console.log("[terminal-proxy] auth OK, userId:", userId);

      const instance = await prisma.instance.findUnique({
        where: { userId },
      });

      if (!instance || instance.status !== "running" || !instance.tailscaleHostname || !instance.apiKey) {
        console.log("[terminal-proxy] instance check failed:", {
          found: !!instance,
          status: instance?.status,
        });
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }

      const tenantApiKey = decryptApiKey(instance.apiKey);
      const upstreamUrl = `wss://${instance.tailscaleHostname}:3100/terminal?token=${encodeURIComponent(tenantApiKey)}`;

      console.log("[terminal-proxy] connecting upstream to", instance.tailscaleHostname);

      wss.handleUpgrade(req, socket, head, (browserWs: InstanceType<typeof WebSocket>) => {
        const upstreamWs = new WebSocket(upstreamUrl, {
          rejectUnauthorized: false,
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
