// signals_filter.ts
//
// PR fix/learn-signal-writer-block-engineering-tags
//
// Engineering-tag deny-list applied at POST /api/v1/signals so internal
// ops / engineering prose never becomes a principal-visible signal.
// Lives in its own module (no state.db imports) so it can be unit-tested
// without standing up the full ctrl-api or the .sql migration loader.
//
// Triggering incident (2026-05-19, david's tenant): the morning brief
// surfaced *"The P3-2 smoke detector re-applied its alert overnight"*.
// "P3-2" is internal storage-epic phase numbering. The signal row was:
//   id          aeb40ea8-0d1d-40d6-aafa-ce2303d62d14
//   source_type manual
//   actor       smoke
//   body        "P3-2 reapply smoke"
// A maintenance / smoke-test path wrote it as a decision-grade signal.
//
// Policy (conservative — false-negatives are safer than false-positives
// since blocking principal-visible items is worse than letting noise
// through):
//
//   * Reject when ``display_headline`` / ``display_body`` / ``body``
//     starts with a known engineering-tag prefix:
//     ``STORE-``, ``OPS-``, ``MCP-``, ``SM-[A-Z]``, ``OBS-<digit>``,
//     ``P<digit>-<digit>`` (bare or bracketed).
//   * Reject when ``source_type`` is in OPERATIONAL_SOURCE_TYPES (infra
//     probes / janitors / reapers / CI).
//   * Reject when ``actor`` is in OPERATIONAL_ACTORS (smoke-test
//     markers). The david row triggers this branch.
//
// Returns ``null`` when the row should be accepted, or a
// ``{ reason, pattern }`` envelope the route uses to emit a 400. The
// writer logs the rejection but the worker continues — the signal
// never reaches the table, so no downstream reader has to filter it.

export const ENGINEERING_TAG_PATTERN: RegExp =
  /^\s*[\[(]*\s*(?:STORE-|OPS-|MCP-|SM-[A-Z]|OBS-\d|P\d+-\d+\b)/;

// source_type values that originate from infra paths, not user-facing
// events. Lower-case match. Conservative — extend only when you can
// point at a writer that proves the source is operational.
export const OPERATIONAL_SOURCE_TYPES: ReadonlySet<string> = new Set<string>([
  "internal:smoke-test",
  "ops:janitor",
  "ops:reaper",
  "worker:reaper",
  "ci:probe",
  "ci:smoke",
]);

// actor values that mark a row as having been emitted by a smoke /
// janitor / reaper path rather than a real principal-facing event.
export const OPERATIONAL_ACTORS: ReadonlySet<string> = new Set<string>([
  "smoke",
  "smoke-test",
  "janitor",
  "reaper",
  "ci",
]);

export interface RejectionReason {
  /** Human-readable why; surfaces in the 400 response. */
  reason: string;
  /** The exact prefix / source / actor that matched (for logs + tests). */
  pattern?: string;
}

/** True iff the given summary string matches a known engineering-tag prefix. */
export function matchesEngineeringTag(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string" || !value) return null;
  const m = value.match(ENGINEERING_TAG_PATTERN);
  return m ? m[0].trim() : null;
}

/**
 * Inspect an incoming signal and return a rejection reason if the row
 * looks like infra / engineering noise. Returns ``null`` when the row
 * should be accepted. Inputs may be ``null``/``undefined`` (already-
 * normalised optional fields); we short-circuit on missing values.
 */
export function classifyEngineeringNoise(args: {
  source_type: string;
  actor: string | null;
  display_headline: string | null;
  display_body: string | null;
  body: string;
}): RejectionReason | null {
  const srcLower = args.source_type.trim().toLowerCase();
  if (OPERATIONAL_SOURCE_TYPES.has(srcLower)) {
    return { reason: "source_type is operational", pattern: srcLower };
  }
  const actorLower = (args.actor ?? "").trim().toLowerCase();
  if (actorLower && OPERATIONAL_ACTORS.has(actorLower)) {
    return { reason: "actor is operational", pattern: actorLower };
  }
  const headlineHit = matchesEngineeringTag(args.display_headline);
  if (headlineHit) {
    return {
      reason: "display_headline matches engineering-tag deny-list",
      pattern: headlineHit,
    };
  }
  const dbodyHit = matchesEngineeringTag(args.display_body);
  if (dbodyHit) {
    return {
      reason: "display_body matches engineering-tag deny-list",
      pattern: dbodyHit,
    };
  }
  const bodyHit = matchesEngineeringTag(args.body);
  if (bodyHit) {
    return {
      reason: "body matches engineering-tag deny-list",
      pattern: bodyHit,
    };
  }
  return null;
}
