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

    // Authenticate via query param token (WebSocket upgrade can't use custom headers reliably)
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

    // Use `script` to allocate a real PTY for docker exec.
    // This gives us a proper interactive shell (prompt, echo, line editing)
    // without needing the native node-pty module.
    const dockerCmd = `docker compose -f ${COMPOSE_DIR}/docker-compose.yaml exec -it openclaw /bin/sh`;
    proc = spawn("script", ["-q", "-c", dockerCmd, "/dev/null"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Bootstrap: create an `openclaw` CLI wrapper and add to PATH.
    // Written to stdin after shell starts; `clear` hides the setup output.
    proc.stdin!.write(
      `printf '#!/bin/sh\\nexec node /app/openclaw.mjs "$@"\\n' > /tmp/openclaw && chmod +x /tmp/openclaw && export PATH="/tmp:$PATH" && clear\n`,
    );

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

    ws.on("message", (data: Buffer) => {
      if (!Buffer.isBuffer(data) || data.length < 1) return;
      resetIdle();

      const type = data[0];
      const payload = data.subarray(1);

      if (type === MSG_DATA && proc?.stdin?.writable) {
        proc.stdin.write(payload);
      }
    });

    ws.on("close", () => {
      cleanup("client disconnected");
    });

    ws.on("error", () => {
      cleanup("websocket error");
    });

    // Send a connected control message
    const connMsg = JSON.stringify({ type: "connected" });
    const connBuf = Buffer.alloc(1 + Buffer.byteLength(connMsg));
    connBuf[0] = MSG_CONTROL;
    connBuf.write(connMsg, 1);
    ws.send(connBuf);

    resetIdle();
  });
}
