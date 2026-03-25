/**
 * Admin Godmode Terminal Proxy — bridges browser WebSocket to the SaaS host
 * ctrl-api's /godmode-ssh endpoint for direct SSH access to tenant hosts.
 *
 * Flow: Browser WS → /api/admin-terminal → this proxy → ctrl /godmode-ssh → SSH → tenant
 *
 * Auth: Wasp session token (must be admin user)
 * Config: CTRL_SAAS_HOST_URL (internal URL of ctrl-api on SaaS host)
 *         GODMODE_API_KEY (shared secret between Wasp and ctrl)
 */

import type { Server as HttpServer, IncomingMessage } from "http";
import type { Duplex } from "stream";
import type { Application, Request, Response } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { prisma } from "wasp/server";
import { getSessionAndUserFromBearerToken } from "wasp/auth/session";

const CTRL_URL = process.env.CTRL_SAAS_HOST_URL || "http://host.docker.internal:3100";
const GODMODE_KEY = process.env.GODMODE_API_KEY || "";

async function getAdminFromRequest(
  req: IncomingMessage,
): Promise<{ userId: string; isAdmin: boolean } | null> {
  const result = await getSessionAndUserFromBearerToken(req as any);
  if (!result) return null;
  return { userId: result.user.id, isAdmin: !!(result.user as any).isAdmin };
}

export function registerAdminTerminalStatusRoute(app: Application): void {
  app.get("/api/admin-terminal-status", async (req: Request, res: Response) => {
    try {
      if (!GODMODE_KEY) {
        res.json({ ok: false, error: "not_configured", message: "GODMODE_API_KEY not set" });
        return;
      }

      const admin = await getAdminFromRequest(req as unknown as IncomingMessage);
      if (!admin || !admin.isAdmin) {
        res.status(403).json({ ok: false, error: "forbidden", message: "Admin access required" });
        return;
      }

      const instanceId = req.query.instanceId as string;
      if (!instanceId) {
        res.status(400).json({ ok: false, error: "missing_param", message: "instanceId required" });
        return;
      }

      const instance = await prisma.instance.findUnique({
        where: { id: instanceId },
      });

      if (!instance) {
        res.json({ ok: false, error: "not_found", message: "Instance not found" });
        return;
      }

      if (instance.status !== "running") {
        res.json({ ok: false, error: "not_running", message: `Instance is ${instance.status}` });
        return;
      }

      res.json({ ok: true, instanceName: instance.customerName });
    } catch (err: any) {
      console.error("[admin-terminal-status] error:", err);
      res.status(500).json({ ok: false, error: "internal", message: err.message });
    }
  });
}

export function attachAdminTerminalProxy(server: HttpServer): void {
  if (!GODMODE_KEY) {
    console.log("[admin-terminal] GODMODE_API_KEY not set — admin terminal disabled");
    return;
  }

  console.log("[admin-terminal] attaching admin terminal proxy");
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/api/admin-terminal") return;

    console.log("[admin-terminal] upgrade request received");

    try {
      // Auth via Wasp session token in query param
      const token = url.searchParams.get("token");
      if (token) {
        req.headers.authorization = `Bearer ${token}`;
      }

      const admin = await getAdminFromRequest(req);
      if (!admin || !admin.isAdmin) {
        console.log("[admin-terminal] auth failed — not admin");
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      const instanceId = url.searchParams.get("instanceId");
      if (!instanceId) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }

      const instance = await prisma.instance.findUnique({
        where: { id: instanceId },
      });

      if (!instance || instance.status !== "running") {
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }

      // Connect to the SaaS host's ctrl-api godmode endpoint
      const ctrlWsUrl = CTRL_URL.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
      const upstreamUrl = `${ctrlWsUrl}/godmode-ssh?name=${encodeURIComponent(instance.customerName)}&token=${encodeURIComponent(GODMODE_KEY)}`;

      console.log(`[admin-terminal] connecting to godmode for ${instance.customerName}`);

      wss.handleUpgrade(req, socket, head, (browserWs: InstanceType<typeof WebSocket>) => {
        const upstreamWs = new WebSocket(upstreamUrl);

        let browserClosed = false;
        let upstreamClosed = false;

        function sendControlToBrowser(msg: Record<string, unknown>) {
          if (browserClosed || browserWs.readyState !== WebSocket.OPEN) return;
          const json = JSON.stringify(msg);
          const encoded = new TextEncoder().encode(json);
          const buf = new Uint8Array(1 + encoded.length);
          buf[0] = 0x01; // MSG_CONTROL
          buf.set(encoded, 1);
          browserWs.send(buf);
        }

        function cleanupBoth(reason?: string) {
          if (reason) {
            sendControlToBrowser({ type: "disconnect", reason });
          }
          if (!browserClosed && browserWs.readyState === WebSocket.OPEN) {
            browserWs.close();
          }
          if (!upstreamClosed && upstreamWs.readyState === WebSocket.OPEN) {
            upstreamWs.close();
          }
        }

        upstreamWs.on("open", () => {
          console.log(`[admin-terminal] godmode connected for ${instance.customerName}`);
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

        upstreamWs.on("error", (err: any) => {
          const detail = `Godmode upstream error: ${err.message}`;
          console.error("[admin-terminal]", detail);
          cleanupBoth(detail);
        });

        upstreamWs.on("unexpected-response", (_req: any, httpRes: any) => {
          const detail = `Godmode rejected: HTTP ${httpRes.statusCode}`;
          console.error("[admin-terminal]", detail);
          cleanupBoth(detail);
        });

        upstreamWs.on("close", (code, reason) => {
          console.log("[admin-terminal] upstream closed:", code, reason?.toString());
          upstreamClosed = true;
          cleanupBoth(reason?.toString() || `SSH closed (code: ${code})`);
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
      console.error("[admin-terminal] error:", err);
      socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      socket.destroy();
    }
  });
}
