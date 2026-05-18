import type { Server as HttpServer, IncomingMessage } from "http";
import type { Duplex } from "stream";
import type { Application, Request, Response } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { getSessionAndUserFromBearerToken } from "wasp/auth/session";

/**
 * Terminal proxy — single-VM edition.
 *
 * Bridges the browser terminal WebSocket to the local ctrl-api's `/terminal`
 * endpoint over the Docker compose network. There is no fleet, no Tailscale,
 * no Cloudflare tunnel: every install has exactly one ctrl-api reachable at
 * `ctrl-api:3100` (overridable via CTRL_API_URL). Auth is still the Wasp
 * session token; ctrl-api itself is reached with the shared AAS_API_KEY.
 */

const CTRL_API_URL = process.env.CTRL_API_URL ?? "http://ctrl-api:3100";
const CTRL_API_KEY = process.env.AAS_API_KEY ?? "";

// ws:// for http://, wss:// for https:// — ctrl-api on the compose network
// is plain HTTP, so this is `ws://ctrl-api:3100`.
const CTRL_API_WS_URL = CTRL_API_URL.replace(/^http:/, "ws:").replace(
  /^https:/,
  "wss:",
);

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
      const userId = await getUserIdFromRequest(
        req as unknown as IncomingMessage,
      );
      if (!userId) {
        res.status(401).json({
          ok: false,
          error: "not_authenticated",
          message: "No valid session",
        });
        return;
      }

      if (!CTRL_API_KEY) {
        res.json({
          ok: false,
          error: "not_configured",
          message: "AAS_API_KEY is not configured",
        });
        return;
      }

      res.json({ ok: true });
    } catch (err: any) {
      console.error("[terminal-status] error:", err);
      res
        .status(500)
        .json({ ok: false, error: "internal", message: err.message });
    }
  });

  // Diagnostic endpoint: test upstream connectivity to ctrl-api.
  app.get("/api/terminal-debug", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromRequest(
        req as unknown as IncomingMessage,
      );
      if (!userId) {
        res.status(401).json({ ok: false, error: "not_authenticated" });
        return;
      }

      const results: Record<string, unknown> = { ctrlApiUrl: CTRL_API_URL };

      // Test 1: HTTP health check.
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        const healthRes = await fetch(`${CTRL_API_URL}/api/v1/admin/health`, {
          headers: { Authorization: `Bearer ${CTRL_API_KEY}` },
          signal: controller.signal,
        });
        clearTimeout(timer);
        results.httpHealth = { status: healthRes.status, ok: healthRes.ok };
      } catch (err: any) {
        results.httpHealth = {
          error: err.message,
          code: err.code,
          cause: err.cause?.message,
        };
      }

      // Test 2: WebSocket connection attempt.
      try {
        const wsUrl = `${CTRL_API_WS_URL}/terminal`;
        const wsResult = await new Promise<Record<string, unknown>>(
          (resolve) => {
            const timer = setTimeout(() => {
              testWs.close();
              resolve({ error: "timeout after 10s" });
            }, 10_000);

            const testWs = new WebSocket(wsUrl, {
              headers: { Authorization: `Bearer ${CTRL_API_KEY}` },
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
              httpRes.on("data", (d: any) => (body += d));
              httpRes.on("end", () => {
                testWs.close();
                resolve({
                  error: "unexpected-response",
                  statusCode: httpRes.statusCode,
                  body: body.slice(0, 200),
                });
              });
            });
          },
        );
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

  server.on(
    "upgrade",
    async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host || "localhost"}`,
      );
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

        if (!CTRL_API_KEY) {
          console.log("[terminal-proxy] AAS_API_KEY not configured");
          socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
          socket.destroy();
          return;
        }

        const upstreamUrl = `${CTRL_API_WS_URL}/terminal`;
        console.log("[terminal-proxy] connecting upstream to", upstreamUrl);

        wss.handleUpgrade(
          req,
          socket,
          head,
          (browserWs: InstanceType<typeof WebSocket>) => {
            const upstreamWs = new WebSocket(upstreamUrl, {
              headers: {
                Authorization: `Bearer ${CTRL_API_KEY}`,
              },
            });

            let browserClosed = false;
            let upstreamClosed = false;

            function sendControlToBrowser(msg: Record<string, unknown>) {
              if (browserClosed || browserWs.readyState !== WebSocket.OPEN)
                return;
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
              console.log(
                "[terminal-proxy] upstream closed:",
                code,
                reason?.toString(),
              );
              upstreamClosed = true;
              cleanupBoth(
                reason?.toString() || `Upstream closed (code: ${code})`,
              );
            });

            browserWs.on("close", () => {
              browserClosed = true;
              cleanupBoth();
            });

            browserWs.on("error", () => {
              cleanupBoth();
            });
          },
        );
      } catch (err) {
        console.error("[terminal-proxy] error:", err);
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        socket.destroy();
      }
    },
  );
}
