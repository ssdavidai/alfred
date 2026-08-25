// Pure view derivation for the Codex credential panel (/study#agent).
//
// Mirrors the four states ctrl-api emits from
// GET /api/v1/hermes/codex-auth/profiles. Kept separate from the component so
// the mapping is testable without rendering: the whole point of this panel is
// that it tells the truth about auth, and a panel that renders "Authenticated"
// over an empty token set would be worse than no panel at all.

export type ProfileState = "ok" | "error" | "no_tokens" | "no_provider";

export interface ProfileRow {
  profile: string;
  state: ProfileState;
  last_refresh?: string | null;
  error?: string | null;
}

export interface ProfileView {
  profile: string;
  label: string;
  /** true when this profile can actually make a Codex call. */
  authenticated: boolean;
  /** true when the principal must complete the device-code ceremony. */
  needsAuth: boolean;
  detail: string;
}

const LABEL: Record<ProfileState, string> = {
  ok: "Authenticated",
  error: "Refresh failed",
  no_tokens: "Re-auth required",
  no_provider: "Not connected",
};

/** Short, plain-language reason. Dates render as YYYY-MM-DD; no clock noise. */
function detailFor(r: ProfileRow): string {
  const when = r.last_refresh ? String(r.last_refresh).slice(0, 10) : null;
  switch (r.state) {
    case "ok":
      return when ? `Last refreshed ${when}` : "Token present";
    case "error":
      return r.error
        ? `Token present, last refresh failed (${r.error})`
        : "Token present, last refresh failed";
    case "no_tokens":
      return r.error
        ? `No usable token (${r.error})`
        : "No usable token";
    case "no_provider":
      return "Codex has never been connected on this profile";
  }
}

export function deriveProfileViews(payload: unknown): ProfileView[] {
  const rows = (payload as { profiles?: ProfileRow[] } | null)?.profiles;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    profile: r.profile,
    label: LABEL[r.state] ?? "Unknown",
    // Only `ok` counts as working. `error` keeps a token but the last refresh
    // failed, which is how a credential dies quietly — surfaced, not hidden.
    authenticated: r.state === "ok",
    needsAuth: r.state === "no_tokens" || r.state === "no_provider",
    detail: detailFor(r),
  }));
}

/** True when any supervised profile cannot make a Codex call right now. */
export function anyProfileDegraded(payload: unknown): boolean {
  const views = deriveProfileViews(payload);
  return views.length > 0 && views.some((v) => !v.authenticated);
}
