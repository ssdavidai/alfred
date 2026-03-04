import type http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import { authenticate } from "../auth.js";
import { COMPOSE_DIR } from "../helpers.js";

const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const MSG_DATA = 0x00;
const MSG_CONTROL = 0x01;

let activeSession: WebSocket | null = null;

export function attachTerminalUpgrade(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/terminal") return;

    const token = url.searchParams.get("token");
    if (token) {
      req.headers.authorization = `Bearer ${token}`;
    }

    try {
      authenticate(req);
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    if (activeSession && activeSession.readyState === WebSocket.OPEN) {
      socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    activeSession = ws;
    let idleTimer: ReturnType<typeof setTimeout>;
    let proc: ChildProcess | null = null;
    let termCols = 80;
    let termRows = 24;

    function resetIdle() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        cleanup("idle timeout");
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
      if (activeSession === ws) activeSession = null;
    }

    function startShell() {
      // Start interactive shell with PTY via script(1).
      // COLUMNS/LINES/TERM are passed as env vars; .ocrc runs stty to set PTY size.
      const dockerCmd = [
        "docker compose",
        `-f ${COMPOSE_DIR}/docker-compose.yaml`,
        "exec -it",
        `-e ENV=/tmp/.ocrc`,
        `-e COLUMNS=${termCols}`,
        `-e LINES=${termRows}`,
        `-e TERM=xterm-256color`,
        "openclaw /bin/sh",
      ].join(" ");

      proc = spawn("script", ["-q", "-c", dockerCmd, "/dev/null"], {
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
        cleanup(`process exited (${code})`);
      });

      proc.on("error", (err) => {
        cleanup(`process error: ${err.message}`);
      });

      resetIdle();
    }

    // Phase 1: Non-interactive setup — create openclaw wrapper + shell rc file.
    // spawn() with array args avoids all shell quoting issues.
    const setupShCmd = [
      "rm -rf /tmp/openclaw /tmp/.ocrc",
      "echo '#!/bin/sh' > /tmp/openclaw",
      "echo 'exec node /app/openclaw.mjs \"$@\"' >> /tmp/openclaw",
      "chmod +x /tmp/openclaw",
      "echo 'export PATH=\"/tmp:/app/node_modules/.bin:$PATH\"' > /tmp/.ocrc",
      "echo 'export TERM=xterm-256color' >> /tmp/.ocrc",
      "echo 'stty cols ${COLUMNS:-80} rows ${LINES:-24} 2>/dev/null' >> /tmp/.ocrc",
    ].join(" && ");

    const setup = spawn("docker", [
      "compose", "-f", `${COMPOSE_DIR}/docker-compose.yaml`,
      "exec", "-T", "openclaw", "sh", "-c", setupShCmd,
    ], { stdio: "ignore" });

    // Phase 2: Start interactive shell after setup completes (or fails)
    setup.on("close", () => startShell());
    setup.on("error", () => startShell());

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
            // Resize the PTY if shell is already running
            if (proc?.stdin?.writable) {
              proc.stdin.write(`stty cols ${msg.cols} rows ${msg.rows} 2>/dev/null\n`);
            }
          }
        } catch {
          // ignore malformed control messages
        }
      }
    });

    ws.on("close", () => {
      cleanup("client disconnected");
    });

    ws.on("error", () => {
      cleanup("websocket error");
    });

    // Send connected control message
    const connMsg = JSON.stringify({ type: "connected" });
    const connBuf = Buffer.alloc(1 + Buffer.byteLength(connMsg));
    connBuf[0] = MSG_CONTROL;
    connBuf.write(connMsg, 1);
    ws.send(connBuf);
  });
}
