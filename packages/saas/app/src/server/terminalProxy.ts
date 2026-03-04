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

  // Diagnostic endpoint: test upstream connectivity to tenant
  app.get("/api/terminal-debug", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromRequest(req as unknown as IncomingMessage);
      if (!userId) {
        res.status(401).json({ ok: false, error: "not_authenticated" });
        return;
      }

      const instance = await prisma.instance.findUnique({ where: { userId } });
      if (!instance || !instance.tailscaleHostname || !instance.apiKey) {
        res.json({ ok: false, error: "no_instance_or_not_ready" });
        return;
      }

      const tenantApiKey = decryptApiKey(instance.apiKey);
      const hostname = instance.tailscaleHostname;
      const results: Record<string, unknown> = { hostname };

      // Test 0: DNS resolution
      try {
        const dns = await import("dns");
        const dnsResult = await new Promise<string>((resolve, reject) => {
          dns.default.lookup(hostname, (err: any, address: string) => {
            if (err) reject(err);
            else resolve(address);
          });
        });
        results.dnsResolution = dnsResult;
      } catch (err: any) {
        results.dnsResolution = { error: err.message };
      }

      // Test 1: HTTP health check (proves basic HTTPS connectivity works)
      try {
        const healthUrl = `https://${hostname}:3100/api/v1/admin/health`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        const healthRes = await fetch(healthUrl, {
          headers: { Authorization: `Bearer ${tenantApiKey}` },
          signal: controller.signal,
        });
        clearTimeout(timer);
        results.httpHealth = { status: healthRes.status, ok: healthRes.ok };
      } catch (err: any) {
        results.httpHealth = { error: err.message, code: err.code, cause: err.cause?.message };
      }

      // Test 2: Call ctrl debug/headers endpoint WITH upgrade headers
      // This tells us: (a) what headers the ctrl API actually sees, (b) terminal module status
      try {
        const debugUrl = `https://${hostname}:3100/api/v1/admin/debug/headers`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        const debugRes = await fetch(debugUrl, {
          headers: {
            Authorization: `Bearer ${tenantApiKey}`,
            Connection: "Upgrade",
            Upgrade: "websocket",
          },
          signal: controller.signal,
        });
        clearTimeout(timer);
        const debugData = await debugRes.json();
        results.ctrlDebugHeaders = debugData;
      } catch (err: any) {
        results.ctrlDebugHeaders = { error: err.message, code: err.code };
      }

      // Test 3: WebSocket connection attempt
      try {
        const wsUrl = `wss://${hostname}:3100/terminal`;
        const wsResult = await new Promise<Record<string, unknown>>((resolve) => {
          const timer = setTimeout(() => {
            testWs.close();
            resolve({ error: "timeout after 10s" });
          }, 10_000);

          const testWs = new WebSocket(wsUrl, {
            headers: { Authorization: `Bearer ${tenantApiKey}` },
          });

          testWs.on("open", () => {
            clearTimeout(timer);
            testWs.close();
            resolve({ connected: true });
          });

          testWs.on("error", (err: any) => {
            clearTimeout(timer);
            resolve({ error: err.message, code: err.code });
          });

          testWs.on("unexpected-response", (_req: any, httpRes: any) => {
            clearTimeout(timer);
            let body = "";
            httpRes.on("data", (d: any) => body += d);
            httpRes.on("end", () => {
              testWs.close();
              resolve({
                error: "unexpected-response",
                statusCode: httpRes.statusCode,
                body: body.slice(0, 200),
              });
            });
          });
        });
        results.wsTest = wsResult;
      } catch (err: any) {
        results.wsTest = { error: err.message };
      }

      res.json({ ok: true, diagnostics: results });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
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
      const upstreamUrl = `wss://${instance.tailscaleHostname}:3100/terminal`;

      console.log("[terminal-proxy] connecting upstream to", instance.tailscaleHostname);

      wss.handleUpgrade(req, socket, head, (browserWs: InstanceType<typeof WebSocket>) => {
        const upstreamWs = new WebSocket(upstreamUrl, {
          headers: {
            Authorization: `Bearer ${tenantApiKey}`,
          },
        });

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

        upstreamWs.on("error", (err: any) => {
          const detail = `Upstream error: ${err.message} (code: ${err.code || "none"})`;
          console.error("[terminal-proxy]", detail);
          cleanupBoth(detail);
        });

        upstreamWs.on("unexpected-response", (_req: any, httpRes: any) => {
          const detail = `Upstream rejected: HTTP ${httpRes.statusCode} ${httpRes.statusMessage}`;
          console.error("[terminal-proxy]", detail);
          cleanupBoth(detail);
        });

        upstreamWs.on("close", (code, reason) => {
          console.log("[terminal-proxy] upstream closed:", code, reason?.toString());
          upstreamClosed = true;
          cleanupBoth(reason?.toString() || `Upstream closed (code: ${code})`);
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
