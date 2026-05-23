/**
 * Phase-2 Lane III · Commit 1 — `/household` graceful empty-state.
 *
 * RULES.md does not exist on a fresh tenant: the file is composed by the
 * onboarding pipeline after the first brief lands. Before that, the
 * workspace fetch returns HTTP 404, which surfaces as `isError: true`
 * with `error.statusCode === 404`. The previous behaviour rendered the
 * generic "Alfred couldn't load your standing rules just now — Retry"
 * message, which reads as a failure even though the absence is
 * expected.
 *
 * `rulesViewState` is the pure decision function: given the loading /
 * error / data signals from `useQuery(getWorkspaceFile, "RULES.md")`,
 * pick one of four view states the editor can render.
 *
 *   "composing"  RULES.md is absent (404). Show the "still composing"
 *                copy. Once the onboarding pipeline writes RULES.md,
 *                this transitions to "ready".
 *   "error"      Real fetch failure (5xx, 4xx other than 404, network).
 *                Show the existing "couldn't load — Retry" copy.
 *   "loading"    First mount, neither data nor error yet.
 *   "ready"      Data resolved; render the rules list / editor.
 *
 * Inputs are typed loose because Wasp's `useQuery` result is `any` at
 * the call site and the error shape varies by transport (Wasp's
 * HttpError carries `.statusCode`; a raw fetch error may not).
 */

export type RulesViewState = "composing" | "loading" | "error" | "ready";

export interface RulesViewInputs {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  /** True once the component has parsed `data` at least once. The page
   *  guards transient re-fetches behind this flag so the editor doesn't
   *  flicker back to a loading state mid-session. */
  seeded: boolean;
}

/** Pull a status code off an error object. Wasp HttpError exposes
 *  `.statusCode`; some libraries use `.status`. Treat absence as
 *  "unknown" rather than guessing. */
function statusOf(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const e = err as { statusCode?: unknown; status?: unknown };
    if (typeof e.statusCode === "number") return e.statusCode;
    if (typeof e.status === "number") return e.status;
  }
  return undefined;
}

export function rulesViewState(inputs: RulesViewInputs): RulesViewState {
  const { data, isLoading, isError, error, seeded } = inputs;

  // Already parsed once — stay on "ready" through subsequent refetches.
  if (seeded) return "ready";

  if (isError) {
    // 404 is the expected absence — RULES.md hasn't been composed yet.
    return statusOf(error) === 404 ? "composing" : "error";
  }

  if (isLoading) return "loading";

  // No error, not loading, but data is undefined — the fetch hasn't
  // resolved yet (Wasp's initial render). Hold the loading copy rather
  // than rendering "ready" against undefined data.
  if (data === undefined || data === null) return "loading";

  return "ready";
}
