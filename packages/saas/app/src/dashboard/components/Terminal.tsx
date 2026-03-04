import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

const MSG_DATA = 0x00;
const MSG_CONTROL = 0x01;

type Status = "connecting" | "connected" | "disconnected";

export default function Terminal() {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<Status>("disconnected");
  const [disconnectReason, setDisconnectReason] = useState<string>("");

  const connect = useCallback(async () => {
    if (!containerRef.current) return;

    // Clean up previous
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

    // Pre-flight check: verify auth and instance before WebSocket
    try {
      const statusRes = await fetch("/api/terminal-status", { credentials: "include" });
      const statusData = await statusRes.json();
      if (!statusData.ok) {
        const messages: Record<string, string> = {
          not_authenticated: `Not authenticated. Cookies: ${statusData.debug?.cookieNames?.join(", ") || "none"}`,
          no_instance: "No instance found. Please complete setup first.",
          not_running: statusData.message || "Instance is not running.",
          not_ready: "Instance is still provisioning. Please wait.",
          internal: `Server error: ${statusData.message}`,
        };
        setDisconnectReason(messages[statusData.error] || statusData.message || "Pre-flight check failed");
        setStatus("disconnected");
        return;
      }
    } catch {
      // Status endpoint not available — proceed anyway
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/terminal`;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', monospace",
      theme: {
        background: "#0A0A0A",
        foreground: "#E8E4DE",
        cursor: "#C9A96E",
        selectionBackground: "rgba(201, 169, 110, 0.3)",
        black: "#0A0A0A",
        red: "#E06C75",
        green: "#98C379",
        yellow: "#C9A96E",
        blue: "#61AFEF",
        magenta: "#C678DD",
        cyan: "#56B6C2",
        white: "#E8E4DE",
        brightBlack: "#5C6370",
        brightRed: "#E06C75",
        brightGreen: "#98C379",
        brightYellow: "#C9A96E",
        brightBlue: "#61AFEF",
        brightMagenta: "#C678DD",
        brightCyan: "#56B6C2",
        brightWhite: "#FFFFFF",
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

    ws.onopen = () => {
      // Connection established, waiting for server connected message
    };

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

    // Send terminal input to server
    term.onData((data: string) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const encoded = new TextEncoder().encode(data);
      const msg = new Uint8Array(1 + encoded.length);
      msg[0] = MSG_DATA;
      msg.set(encoded, 1);
      ws.send(msg.buffer);
    });

    // Handle resize
    const handleResize = () => {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        const resizeMsg = JSON.stringify({
          type: "resize",
          cols: term.cols,
          rows: term.rows,
        });
        const encoded = new TextEncoder().encode(resizeMsg);
        const msg = new Uint8Array(1 + encoded.length);
        msg[0] = MSG_CONTROL;
        msg.set(encoded, 1);
        ws.send(msg.buffer);
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      ws.close();
      term.dispose();
    };
  }, []);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    connect().then((c) => { cleanup = c; });
    return () => {
      cleanup?.();
    };
  }, [connect]);

  return (
    <div className="flex h-full flex-col">
      {/* Status bar */}
      <div className="flex items-center justify-between border-b border-gold-dim/40 bg-[#0A0A0A] px-4 py-2">
        <div className="flex items-center gap-2">
          <div
            className={`h-2 w-2 rounded-full ${
              status === "connected"
                ? "bg-emerald-400"
                : status === "connecting"
                  ? "bg-yellow-400 animate-pulse"
                  : "bg-red-400"
            }`}
          />
          <span className="font-mono text-xs text-muted-foreground">
            {status === "connected"
              ? "Connected to OpenClaw"
              : status === "connecting"
                ? "Connecting..."
                : "Disconnected"}
          </span>
        </div>

        {status === "disconnected" && (
          <button
            onClick={connect}
            className="font-mono text-[0.62rem] uppercase tracking-[0.3em] text-gold transition-colors hover:text-cream"
          >
            Reconnect
          </button>
        )}
      </div>

      {/* Disconnect reason */}
      {status === "disconnected" && disconnectReason && (
        <div className="border-b border-gold-dim/40 bg-red-400/5 px-4 py-1.5">
          <span className="font-mono text-xs text-red-400">{disconnectReason}</span>
        </div>
      )}

      {/* Terminal container */}
      <div
        ref={containerRef}
        className="flex-1 bg-[#0A0A0A] p-2"
        style={{ minHeight: "400px" }}
      />
    </div>
  );
}
