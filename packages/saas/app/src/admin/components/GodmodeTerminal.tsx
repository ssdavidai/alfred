import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import GodmodeQuickCommands from "./GodmodeQuickCommands";

const MSG_DATA = 0x00;
const MSG_CONTROL = 0x01;

function getWaspSessionId(): string | null {
  try {
    const raw = localStorage.getItem("wasp:sessionId");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

type Status = "connecting" | "connected" | "disconnected";

interface Props {
  instanceId: string;
  instanceName: string;
}

export default function GodmodeTerminal({ instanceId, instanceName }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<Status>("disconnected");
  const [disconnectReason, setDisconnectReason] = useState<string>("");

  const injectCommand = useCallback((cmd: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const encoded = new TextEncoder().encode(cmd);
    const buf = new Uint8Array(1 + encoded.length);
    buf[0] = MSG_DATA;
    buf.set(encoded, 1);
    ws.send(buf);
  }, []);

  const connect = useCallback(async () => {
    if (!containerRef.current) return;

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (termRef.current) {
      termRef.current.dispose();
      termRef.current = null;
    }

    setStatus("connecting");
    setDisconnectReason("");

    const sessionId = getWaspSessionId();
    if (!sessionId) {
      setDisconnectReason("Not authenticated. Please log in again.");
      setStatus("disconnected");
      return;
    }

    // Pre-flight check
    try {
      const statusRes = await fetch(
        `/api/admin-terminal-status?instanceId=${encodeURIComponent(instanceId)}`,
        { headers: { Authorization: `Bearer ${sessionId}` } },
      );
      const statusData = await statusRes.json();
      if (!statusData.ok) {
        setDisconnectReason(statusData.message || "Pre-flight check failed");
        setStatus("disconnected");
        return;
      }
    } catch {
      // proceed anyway
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/admin-terminal?token=${encodeURIComponent(sessionId)}&instanceId=${encodeURIComponent(instanceId)}`;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', monospace",
      theme: {
        background: "#0A0A0A",
        foreground: "#E8E4DE",
        cursor: "#E06C75",
        selectionBackground: "rgba(224, 108, 117, 0.3)",
        black: "#0A0A0A",
        red: "#E06C75",
        green: "#98C379",
        yellow: "#C9A96E",
        blue: "#61AFEF",
        magenta: "#C678DD",
        cyan: "#56B6C2",
        white: "#E8E4DE",
      },
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onmessage = (event: MessageEvent) => {
      const buf = new Uint8Array(event.data as ArrayBuffer);
      if (buf.length < 1) return;

      const type = buf[0];
      const payload = buf.subarray(1);

      if (type === MSG_DATA) {
        term.write(payload);
      } else if (type === MSG_CONTROL) {
        try {
          const msg = JSON.parse(new TextDecoder().decode(payload));
          if (msg.type === "connected") {
            setStatus("connected");
          } else if (msg.type === "disconnect") {
            setDisconnectReason(msg.reason || "Connection closed");
            setStatus("disconnected");
          }
        } catch {
          // ignore
        }
      }
    };

    ws.onclose = () => {
      setStatus("disconnected");
      setDisconnectReason((prev) => prev || "Connection closed");
    };

    ws.onerror = () => {
      setStatus("disconnected");
      setDisconnectReason((prev) => prev || "WebSocket connection failed");
    };

    term.onData((data: string) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const encoded = new TextEncoder().encode(data);
      const buf = new Uint8Array(1 + encoded.length);
      buf[0] = MSG_DATA;
      buf.set(encoded, 1);
      ws.send(buf);
    });

    // Intercept paste events to send full text as a single write,
    // preventing xterm.js from splitting on newlines.
    const handlePaste = (e: ClipboardEvent) => {
      e.preventDefault();
      const text = e.clipboardData?.getData("text");
      if (!text || ws.readyState !== WebSocket.OPEN) return;
      const encoded = new TextEncoder().encode(text);
      const buf = new Uint8Array(1 + encoded.length);
      buf[0] = MSG_DATA;
      buf.set(encoded, 1);
      ws.send(buf);
    };
    containerRef.current.addEventListener("paste", handlePaste);

    // Handle resize
    const ro = new ResizeObserver(() => {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        const msg = JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows });
        const encoded = new TextEncoder().encode(msg);
        const buf = new Uint8Array(1 + encoded.length);
        buf[0] = MSG_CONTROL;
        buf.set(encoded, 1);
        ws.send(buf);
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      containerRef.current?.removeEventListener("paste", handlePaste);
    };
  }, [instanceId]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      termRef.current?.dispose();
    };
  }, [connect]);

  return (
    <div className="flex flex-col overflow-hidden rounded border border-amber-900/40">
      {/* Warning banner */}
      <div className="border-b border-amber-900/40 bg-amber-950/30 px-4 py-2">
        <p className="font-mono text-xs text-amber-400">
          GODMODE — Direct SSH to <span className="font-bold">{instanceName}</span> host (deploy user).
          All commands execute on the tenant VPS.
        </p>
      </div>

      {/* Quick commands */}
      <GodmodeQuickCommands onCommand={injectCommand} disabled={status !== "connected"} />

      {/* Status bar */}
      <div className="flex items-center gap-2 border-b border-amber-900/20 bg-black/40 px-4 py-1.5">
        <div
          className={`h-2 w-2 rounded-full ${
            status === "connected"
              ? "bg-green-500"
              : status === "connecting"
                ? "bg-yellow-500 animate-pulse"
                : "bg-red-500"
          }`}
        />
        <span className="font-mono text-[11px] text-muted-foreground">
          {status === "connected"
            ? `Connected to ${instanceName}`
            : status === "connecting"
              ? "Connecting..."
              : disconnectReason || "Disconnected"}
        </span>
        {status === "disconnected" && (
          <button
            onClick={connect}
            className="ml-auto font-mono text-[11px] text-amber-400 underline hover:text-amber-300"
          >
            Reconnect
          </button>
        )}
      </div>

      {/* Terminal */}
      <div ref={containerRef} className="flex-1 bg-[#0A0A0A]" style={{ minHeight: 400 }} />
    </div>
  );
}
