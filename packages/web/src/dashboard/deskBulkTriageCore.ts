// deskBulkTriageCore — pure selection/preview state for Desk bulk triage (#542).
// No React/Wasp imports. Tested by deskBulkTriageCore.test.ts.
// delegate is NOT offered — the server returns 400 for it.

export type BulkIntent = "done" | "defer" | "noise";

export interface BulkPreviewResult {
  would_apply: number;
  would_skip: number;
  /** Verbatim suppression-training warning (noise intent only). */
  noise_warning: string | null;
  /** Verbatim note about manual-only reversal. */
  reversal_note: string | null;
}

export const addToSelection = (s: ReadonlySet<string>, id: string): ReadonlySet<string> =>
  new Set([...s, id]);

export const removeFromSelection = (s: ReadonlySet<string>, id: string): ReadonlySet<string> => {
  const n = new Set(s); n.delete(id); return n;
};

export const clearSelection = (): ReadonlySet<string> => new Set();

export const selectAll = (ids: string[]): ReadonlySet<string> => new Set(ids);

export const canSubmit = (s: ReadonlySet<string>): boolean => s.size > 0;

export function mapPreviewResponse(raw: unknown): BulkPreviewResult {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    would_apply: typeof r.would_apply === "number" ? r.would_apply : 0,
    would_skip: typeof r.would_skip === "number" ? r.would_skip : 0,
    noise_warning: typeof r.noise_warning === "string" && r.noise_warning ? r.noise_warning : null,
    reversal_note: typeof r.reversal_note === "string" && r.reversal_note ? r.reversal_note : null,
  };
}
