// codexAuthCore.ts — pure state derivation for the Codex OAuth device-code
// ceremony surface in HermesAuthBanner. Zero imports; runs in any JS env.
// Mirrors the five statuses emitted by hermes_codex_auth.ts (Lane I #566).

export type CodexStatus =
  | "not_started" | "awaiting_approval" | "complete" | "failed" | "timeout";

export interface CodexStatusPayload {
  status: CodexStatus;
  user_code?: string;
  verification_uri?: string;
  error?: string;
}

// Seven view phases:
//   idle            — no ceremony started; show CLI fallback + Connect button
//   waiting_for_code — started; user_code not yet in the response (~2 s later)
//   show_code       — user_code + uri ready; principal must visit the URL
//   restarting      — complete ACK'd; restart in flight (~30 s)
//   done            — restart finished; banner may be dismissed
//   failed          — ceremony exited non-zero
//   timeout         — device code expired; principal must Retry
export type CodexViewState =
  | { phase: "idle" }
  | { phase: "waiting_for_code" }
  | { phase: "show_code"; user_code: string; verification_uri: string }
  | { phase: "restarting" }
  | { phase: "done" }
  | { phase: "failed"; error: string }
  | { phase: "timeout" };

/** Maps a raw status payload to a view phase. `restarting` overrides server status. */
export function deriveCodexViewState(
  payload: CodexStatusPayload | null | undefined,
  restarting: boolean,
): CodexViewState {
  if (restarting) return { phase: "restarting" };
  if (!payload || payload.status === "not_started") return { phase: "idle" };
  switch (payload.status) {
    case "awaiting_approval":
      // user_code arrives seconds AFTER start fires — never assume it is present.
      if (payload.user_code && payload.verification_uri)
        return { phase: "show_code", user_code: payload.user_code, verification_uri: payload.verification_uri };
      return { phase: "waiting_for_code" };
    case "complete": return { phase: "done" };
    case "failed": return { phase: "failed", error: payload.error ?? "authentication failed" };
    case "timeout": return { phase: "timeout" };
  }
}

/** True for the three server-terminal statuses: complete / failed / timeout. */
export function isTerminal(status: CodexStatus | undefined): boolean {
  return status === "complete" || status === "failed" || status === "timeout";
}

/**
 * Whether the component should fire the hermes restart call.
 * Extracted for testability — use with sentRestart.current:
 *   if (shouldDispatchRestart(status, sent)) { sent=true; dispatch(); }
 */
export function shouldDispatchRestart(status: CodexStatus | undefined, alreadySent: boolean): boolean {
  return status === "complete" && !alreadySent;
}
