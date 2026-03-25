/**
 * Godmode SSH — WebSocket endpoint that spawns an interactive SSH session
 * to a tenant host.  Runs on the SaaS host's ctrl-api (which has the SSH
 * keys and Tailscale access).
 *
 * Auth: separate GODMODE_API_KEY env var (not the tenant AAS_API_KEY).
 * If GODMODE_API_KEY is not set, the endpoint is disabled.
 *
 * Protocol: identical binary framing as terminal.ts (0x00 = data, 0x01 = control).
 */

import type http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import { getInstanceByName } from "../../db/queries.js";
import { getPrivateKeyPath } from "../../infra/keys.js";

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes (longer than user terminal)
const MSG_DATA = 0x00;
const MSG_CONTROL = 0x01;

// One active session per instance
const activeSessions = new Map<string, WebSocket>();

export function attachGodmodeSshUpgrade(server: http.Server): void {
  const godmodeKey = process.env.GODMODE_API_KEY;
  if (!godmodeKey) {
    console.log("GODMODE_API_KEY not set — /godmode-ssh endpoint disabled");
    return;
  }

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/godmode-ssh") return;

    // Auth via GODMODE_API_KEY
    const token = url.searchParams.get("token");
    if (token !== godmodeKey) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const instanceName = url.searchParams.get("name");
    if (!instanceName) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    // Check for existing session
    const existing = activeSessions.get(instanceName);
    if (existing && existing.readyState === WebSocket.OPEN) {
      socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, instanceName);
    });
  });

  wss.on("connection", async (ws: WebSocket, _req: http.IncomingMessage, instanceName: string) => {
    activeSessions.set(instanceName, ws);
    let idleTimer: ReturnType<typeof setTimeout>;
    let proc: ChildProcess | null = null;
    let termCols = 80;
    let termRows = 24;

    function resetIdle() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        cleanup("idle timeout (30 min)");
      }, IDLE_TIMEOUT_MS);
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
      activeSessions.delete(instanceName);
    }

    // Look up instance
    const instance = getInstanceByName(instanceName);
    if (!instance) {
      cleanup(`instance not found: ${instanceName}`);
      return;
    }

    if (!instance.ip_address) {
      cleanup(`instance has no IP address: ${instanceName}`);
      return;
    }

    // Resolve SSH key
    let keyPath: string;
    try {
      keyPath = await getPrivateKeyPath(instance.id);
    } catch {
      cleanup(`SSH key not found for instance ${instance.id}`);
      return;
    }

    // Determine target — prefer Tailscale IP if available, fall back to public IP
    const targetIp = instance.tailscale_ip || instance.ip_address;

    // Spawn SSH via script(1) for PTY
    const sshCmd = [
      `ssh -i ${keyPath}`,
      "-o StrictHostKeyChecking=accept-new",
      "-o ServerAliveInterval=30",
      `-o SetEnv=COLUMNS=${termCols} LINES=${termRows} TERM=xterm-256color`,
      `-tt deploy@${targetIp} bash`,
    ].join(" ");

    proc = spawn("script", ["-q", "-c", sshCmd, "/dev/null"], {
      stdio: ["pipe", "pipe", "pipe"],
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

    proc.on("exit", (code) => {
      cleanup(`SSH exited (${code})`);
    });

    proc.on("error", (err) => {
      cleanup(`SSH error: ${err.message}`);
    });

    resetIdle();

    // Handle incoming messages
    ws.on("message", (data: Buffer) => {
      if (!Buffer.isBuffer(data) || data.length < 1) return;
      resetIdle();

      const type = data[0];
      const payload = data.subarray(1);

      if (type === MSG_DATA) {
        if (proc?.stdin?.writable) {
          proc.stdin.write(payload);
        }
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
        } catch {
          // ignore malformed control messages
        }
      }
    });

    ws.on("close", () => cleanup("client disconnected"));
    ws.on("error", () => cleanup("websocket error"));

    // Send connected control message
    const connMsg = JSON.stringify({ type: "connected", instance: instanceName, ip: targetIp });
    const connBuf = Buffer.alloc(1 + Buffer.byteLength(connMsg));
    connBuf[0] = MSG_CONTROL;
    connBuf.write(connMsg, 1);
    ws.send(connBuf);

    console.log(`[godmode] SSH session opened: ${instanceName} → deploy@${targetIp}`);
  });
}
