import * as httpMod from "node:http";
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { authenticate } from "../auth.js";

const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const MSG_DATA = 0x00;
const MSG_CONTROL = 0x01;

let activeSession: WebSocket | null = null;

/**
 * Docker Engine API-based terminal with proper PTY support.
 *
 * Uses Docker's exec API with Tty:true for real PTY allocation.
 * Resize calls /exec/{id}/resize which sends SIGWINCH to the process,
 * so full-screen TUI apps (OpenClaw configure, vi, etc.) work correctly.
 */

function dockerApi(
  path: string,
  method: string,
  body?: unknown,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpMod.request(
      { socketPath: "/var/run/docker.sock", path, method, headers: body ? { "Content-Type": "application/json" } : {} },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c));
        res.on("end", () => resolve({ statusCode: res.statusCode || 200, body: data }));
      },
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function dockerApiJson(path: string, method: string, body?: unknown): Promise<any> {
  return dockerApi(path, method, body).then(({ body: b }) => {
    try { return JSON.parse(b); } catch { return b; }
  });
}

/**
 * Start a Docker exec and return the raw bidirectional TCP socket.
 * With Tty:true, Docker hijacks the HTTP connection into a raw stream:
 * - Reading from the socket = stdout/stderr from the process
 * - Writing to the socket = stdin to the process
 */
function dockerExecStart(execId: string): Promise<import("node:net").Socket> {
  return new Promise((resolve, reject) => {
    const req = httpMod.request(
      {
        socketPath: "/var/run/docker.sock",
        path: `/exec/${execId}/start`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connection": "Upgrade",
          "Upgrade": "tcp",
        },
      },
      (res) => {
        // Non-upgrade response = error
        let data = "";
        res.on("data", (c: Buffer) => (data += c));
        res.on("end", () => reject(new Error(`exec start failed (${res.statusCode}): ${data}`)));
      },
    );

    req.on("upgrade", (_res, socket: import("node:net").Socket, _head) => {
      resolve(socket);
    });

    req.on("error", reject);
    req.write(JSON.stringify({ Tty: true }));
    req.end();
  });
}

async function findOpenClawContainer(): Promise<string | null> {
  const data = await dockerApiJson(
    "/containers/json?filters=" + encodeURIComponent(JSON.stringify({ name: ["compose-openclaw-1"] })),
    "GET",
  );
  if (Array.isArray(data) && data.length > 0) return data[0].Id;
  // Fallback: try any container with "openclaw" in the name
  const all = await dockerApiJson("/containers/json", "GET");
  if (Array.isArray(all)) {
    const oc = all.find((c: any) => c.Names?.some((n: string) => n.includes("openclaw")));
    if (oc) return oc.Id;
  }
  return null;
}

export function attachTerminalUpgrade(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/terminal") return;

    const token = url.searchParams.get("token");
    if (token) req.headers.authorization = `Bearer ${token}`;

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

  wss.on("connection", async (ws) => {
    activeSession = ws;
    let idleTimer: ReturnType<typeof setTimeout>;
    let execId: string | null = null;
    let execSocket: import("node:net").Socket | null = null;

    function resetIdle() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => cleanup("idle timeout"), IDLE_TIMEOUT_MS);
    }

    function sendData(chunk: Buffer) {
      if (ws.readyState !== WebSocket.OPEN) return;
      const buf = Buffer.alloc(1 + chunk.length);
      buf[0] = MSG_DATA;
      chunk.copy(buf, 1);
      ws.send(buf);
    }

    function sendControl(msg: Record<string, unknown>) {
      if (ws.readyState !== WebSocket.OPEN) return;
      const json = JSON.stringify(msg);
      const buf = Buffer.alloc(1 + Buffer.byteLength(json));
      buf[0] = MSG_CONTROL;
      buf.write(json, 1);
      ws.send(buf);
    }

    function cleanup(reason: string) {
      clearTimeout(idleTimer);
      if (execSocket && !execSocket.destroyed) {
        execSocket.destroy();
        execSocket = null;
      }
      sendControl({ type: "disconnect", reason });
      if (ws.readyState === WebSocket.OPEN) ws.close();
      if (activeSession === ws) activeSession = null;
    }

    // Find OpenClaw container
    const containerId = await findOpenClawContainer();
    if (!containerId) {
      sendControl({ type: "disconnect", reason: "OpenClaw container not found" });
      ws.close();
      return;
    }

    // Phase 1: Non-interactive setup (create openclaw wrapper + shell rc)
    try {
      const setupCmd = [
        "rm -rf /tmp/openclaw /tmp/.ocrc",
        "printf '#!/bin/sh\\nexec node /app/openclaw.mjs \"$@\"\\n' > /tmp/openclaw",
        "chmod +x /tmp/openclaw",
        "printf 'export PATH=\"/tmp:/app/node_modules/.bin:$PATH\"\\nexport TERM=xterm-256color\\n' > /tmp/.ocrc",
      ].join(" && ");

      const setupExec = await dockerApiJson(
        `/containers/${containerId}/exec`,
        "POST",
        { Cmd: ["sh", "-c", setupCmd], AttachStdout: false, AttachStderr: false },
      );
      if (setupExec?.Id) {
        await dockerApi(`/exec/${setupExec.Id}/start`, "POST", { Detach: true });
      }
    } catch {
      // Setup failed — continue anyway
    }

    // Phase 2: Create exec instance with real PTY
    try {
      const execData = await dockerApiJson(
        `/containers/${containerId}/exec`,
        "POST",
        {
          Cmd: ["sh", "-c", 'export PATH="/tmp:/app/node_modules/.bin:$PATH" TERM=xterm-256color && exec sh -l'],
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: true,
          Env: ["TERM=xterm-256color", "PATH=/tmp:/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
        },
      );

      if (!execData?.Id) {
        cleanup("Failed to create exec instance");
        return;
      }
      execId = execData.Id;

      // Start the exec — Docker upgrades the connection to a raw TCP socket
      execSocket = await dockerExecStart(execId);

      // Docker socket → browser (stdout/stderr from the PTY)
      execSocket.on("data", (chunk: Buffer) => {
        sendData(chunk);
        resetIdle();
      });

      execSocket.on("end", () => cleanup("shell exited"));
      execSocket.on("close", () => cleanup("shell closed"));
      execSocket.on("error", (err: Error) => cleanup(`stream error: ${err.message}`));

      sendControl({ type: "connected" });
      resetIdle();

    } catch (err: any) {
      cleanup(`exec failed: ${err.message}`);
      return;
    }

    // Handle messages from browser
    ws.on("message", async (data: Buffer) => {
      if (!Buffer.isBuffer(data) || data.length < 1) return;
      resetIdle();

      const type = data[0];
      const payload = data.subarray(1);

      if (type === MSG_DATA) {
        // Write to PTY stdin via the Docker exec socket
        if (execSocket && !execSocket.destroyed) {
          execSocket.write(payload);
        }
      } else if (type === MSG_CONTROL) {
        try {
          const msg = JSON.parse(payload.toString());
          if (msg.type === "resize" && msg.cols > 0 && msg.rows > 0 && execId) {
            // Docker exec resize — sends SIGWINCH to the process
            await dockerApi(
              `/exec/${execId}/resize?h=${msg.rows}&w=${msg.cols}`,
              "POST",
            ).catch(() => {});
          }
        } catch {
          // ignore malformed control messages
        }
      }
    });

    ws.on("close", () => cleanup("client disconnected"));
    ws.on("error", () => cleanup("websocket error"));
  });
}
