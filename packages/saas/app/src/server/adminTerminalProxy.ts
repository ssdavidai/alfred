/**
 * Admin Godmode Terminal — direct SSH to tenant hosts from the admin dashboard.
 *
 * The Wasp container has ctrl mounted at /app/alfred-ctrl/ which includes:
 * - data/alfred-ctrl.db (SQLite with instance IPs and SSH key paths)
 * - data/ssh_keys/<id>/id_ed25519 (SSH private keys)
 *
 * Flow: Browser WS → /api/admin-terminal → this handler → spawn ssh → tenant host
 *
 * No intermediate ctrl-api needed. No env vars to configure.
 * Auth: Wasp session token (must be admin user).
 */

import type { Server as HttpServer, IncomingMessage } from "http";
import type { Duplex } from "stream";
import type { Application, Request, Response } from "express";
import { spawn, execSync, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { WebSocketServer, WebSocket } from "ws";
import { prisma } from "wasp/server";
import { getSessionAndUserFromBearerToken } from "wasp/auth/session";

const MSG_DATA = 0x00;
const MSG_CONTROL = 0x01;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CTRL_DATA_DIR = process.env.ALFRED_CTRL_PATH
  ? process.env.ALFRED_CTRL_PATH.replace(/\/dist\/index\.mjs$/, "/data")
  : "/app/alfred-ctrl/data";
const CTRL_DB_PATH = `${CTRL_DATA_DIR}/alfred-ctrl.db`;

// One active session per instance
const activeSessions = new Map<string, WebSocket>();

async function getAdminFromRequest(
  req: IncomingMessage,
): Promise<{ userId: string; isAdmin: boolean } | null> {
  const result = await getSessionAndUserFromBearerToken(req as any);
  if (!result) return null;
  return { userId: result.user.id, isAdmin: !!(result.user as any).isAdmin };
}

/**
 * Look up the ctrl SQLite DB to get the integer instance ID (for SSH key path)
 * and the IP address. Uses the sqlite3 CLI since we can't import node:sqlite
 * in the Wasp build.
 */
function lookupCtrlInstance(customerName: string): { id: number; ip: string } | null {
  if (!existsSync(CTRL_DB_PATH)) return null;
  try {
    const result = execSync(
      `sqlite3 -json "${CTRL_DB_PATH}" "SELECT id, ip_address, tailscale_ip FROM instances WHERE customer_name = '${customerName.replace(/'/g, "''")}' LIMIT 1"`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    const rows = JSON.parse(result || "[]");
    if (!rows.length) return null;
    const row = rows[0];
    return {
      id: row.id,
      ip: row.tailscale_ip || row.ip_address,
    };
  } catch {
    return null;
  }
}

export function registerAdminTerminalStatusRoute(app: Application): void {
  app.get("/api/admin-terminal-status", async (req: Request, res: Response) => {
    try {
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

      const instance = await prisma.instance.findUnique({ where: { id: instanceId } });
      if (!instance) {
        res.json({ ok: false, error: "not_found", message: "Instance not found" });
        return;
      }
      if (instance.status !== "running") {
        res.json({ ok: false, error: "not_running", message: `Instance is ${instance.status}` });
        return;
      }

      // Check SSH key availability
      const ctrl = lookupCtrlInstance(instance.customerName);
      if (!ctrl) {
        res.json({ ok: false, error: "no_ctrl_data", message: "Instance not found in ctrl database" });
        return;
      }

      const keyPath = `${CTRL_DATA_DIR}/ssh_keys/${ctrl.id}/id_ed25519`;
      if (!existsSync(keyPath)) {
        res.json({ ok: false, error: "no_ssh_key", message: "SSH key not found for this instance" });
        return;
      }

      res.json({ ok: true, instanceName: instance.customerName, ip: ctrl.ip });
    } catch (err: any) {
      console.error("[admin-terminal-status] error:", err);
      res.status(500).json({ ok: false, error: "internal", message: err.message });
    }
  });
}

export function attachAdminTerminalProxy(server: HttpServer): void {
  console.log("[admin-terminal] attaching godmode SSH handler");
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/api/admin-terminal") return;

    console.log("[admin-terminal] upgrade request received");

    try {
      const token = url.searchParams.get("token");
      if (token) {
        req.headers.authorization = `Bearer ${token}`;
      }

      const admin = await getAdminFromRequest(req);
      if (!admin || !admin.isAdmin) {
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

      const instance = await prisma.instance.findUnique({ where: { id: instanceId } });
      if (!instance || instance.status !== "running") {
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }

      // Check for existing session
      const existing = activeSessions.get(instance.customerName);
      if (existing && existing.readyState === WebSocket.OPEN) {
        socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
        socket.destroy();
        return;
      }

      // Look up ctrl DB for SSH key path and IP
      const ctrl = lookupCtrlInstance(instance.customerName);
      if (!ctrl) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      const keyPath = `${CTRL_DATA_DIR}/ssh_keys/${ctrl.id}/id_ed25519`;
      if (!existsSync(keyPath)) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws: InstanceType<typeof WebSocket>) => {
        activeSessions.set(instance.customerName, ws);

        let idleTimer: ReturnType<typeof setTimeout>;
        let proc: ChildProcess | null = null;
        let termCols = 80;
        let termRows = 24;

        function resetIdle() {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => cleanup("idle timeout (30 min)"), IDLE_TIMEOUT_MS);
        }

        function cleanup(reason: string) {
          clearTimeout(idleTimer);
          if (proc) {
            proc.kill("SIGKILL");
            proc = null;
          }
          if (ws.readyState === WebSocket.OPEN) {
            const msg = JSON.stringify({ type: "disconnect", reason });
            const buf = Buffer.alloc(1 + Buffer.byteLength(msg));
            buf[0] = MSG_CONTROL;
            buf.write(msg, 1);
            ws.send(buf, () => ws.close());
          }
          activeSessions.delete(instance.customerName);
        }

        // Spawn SSH with PTY via script(1)
        const sshCmd = [
          `ssh -i ${keyPath}`,
          "-o StrictHostKeyChecking=accept-new",
          "-o ServerAliveInterval=30",
          `-tt deploy@${ctrl.ip} bash`,
        ].join(" ");

        proc = spawn("script", ["-q", "-c", sshCmd, "/dev/null"], {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            COLUMNS: String(termCols),
            LINES: String(termRows),
            TERM: "xterm-256color",
          },
        });

        proc.stdout!.on("data", (chunk: Buffer) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const buf = Buffer.alloc(1 + chunk.length);
          buf[0] = MSG_DATA;
          chunk.copy(buf, 1);
          ws.send(buf);
          resetIdle();
        });

        proc.stderr!.on("data", (chunk: Buffer) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const buf = Buffer.alloc(1 + chunk.length);
          buf[0] = MSG_DATA;
          chunk.copy(buf, 1);
          ws.send(buf);
          resetIdle();
        });

        proc.on("exit", (code) => cleanup(`SSH exited (${code})`));
        proc.on("error", (err) => cleanup(`SSH error: ${err.message}`));

        resetIdle();

        // Handle incoming messages
        ws.on("message", (data: Buffer) => {
          if (!Buffer.isBuffer(data) || data.length < 1) return;
          resetIdle();
          const type = data[0];
          const payload = data.subarray(1);

          if (type === MSG_DATA) {
            if (proc?.stdin?.writable) proc.stdin.write(payload);
          } else if (type === MSG_CONTROL) {
            try {
              const msg = JSON.parse(payload.toString());
              if (msg.type === "resize" && msg.cols > 0 && msg.rows > 0) {
                termCols = msg.cols;
                termRows = msg.rows;
                if (proc?.stdin?.writable) {
                  proc.stdin.write(`stty cols ${msg.cols} rows ${msg.rows} 2>/dev/null\n`);
                }
              }
            } catch { /* ignore */ }
          }
        });

        ws.on("close", () => cleanup("client disconnected"));
        ws.on("error", () => cleanup("websocket error"));

        // Send connected control message
        const connMsg = JSON.stringify({
          type: "connected",
          instance: instance.customerName,
          ip: ctrl.ip,
        });
        const connBuf = Buffer.alloc(1 + Buffer.byteLength(connMsg));
        connBuf[0] = MSG_CONTROL;
        connBuf.write(connMsg, 1);
        ws.send(connBuf);

        console.log(`[admin-terminal] SSH session opened: ${instance.customerName} → deploy@${ctrl.ip}`);
      });
    } catch (err) {
      console.error("[admin-terminal] error:", err);
      socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      socket.destroy();
    }
  });
}
