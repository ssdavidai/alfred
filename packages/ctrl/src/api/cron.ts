// Minimal 5-field cron next-fire-time computer.
//
// Used by the chores route to derive `next_run_at` for each chore so
// the /chores list + detail page can show "next run in 14h" without
// querying Temporal. The cron expression itself lives on the chore
// frontmatter (`schedule:` field). Temporal is the actual scheduler;
// we just compute when it will next fire.
//
// Supports:
//   *           — any
//   N           — exact value
//   N-N         — inclusive range
//   N,N,N       — list
//   */N         — step from 0
//   N/M         — step from N (less common but valid)
//   N-M/S       — range with step
//
// 5 fields: minute (0-59) hour (0-23) day-of-month (1-31) month (1-12)
// day-of-week (0-6; 0 = Sunday, 7 also accepted as Sunday).
//
// All times in UTC. If you need TZ-aware scheduling, that's a layer
// higher up — Temporal handles it; this computer only mirrors the
// raw cron semantics.

type FieldRange = { min: number; max: number };

const RANGES: Record<"min" | "hour" | "dom" | "month" | "dow", FieldRange> = {
  min: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dow: { min: 0, max: 6 },
};

/**
 * Parse a single cron field into a sorted set of allowed integers.
 * Returns null on parse failure.
 */
function parseField(raw: string, range: FieldRange): Set<number> | null {
  const out = new Set<number>();
  if (!raw) return null;
  for (const part of raw.split(",")) {
    if (!parsePart(part.trim(), range, out)) return null;
  }
  return out;
}

function parsePart(part: string, range: FieldRange, out: Set<number>): boolean {
  // Split off step: "A/B" or "A-B/C"
  let stepStr: string | null = null;
  let basePart = part;
  const slashIdx = part.indexOf("/");
  if (slashIdx !== -1) {
    basePart = part.slice(0, slashIdx);
    stepStr = part.slice(slashIdx + 1);
  }
  const step = stepStr ? parseInt(stepStr, 10) : 1;
  if (Number.isNaN(step) || step <= 0) return false;

  let start = range.min;
  let end = range.max;
  if (basePart === "*" || basePart === "") {
    // step alone or */N — full range with step
  } else if (basePart.includes("-")) {
    const [a, b] = basePart.split("-");
    const ai = parseInt(a, 10);
    const bi = parseInt(b, 10);
    if (Number.isNaN(ai) || Number.isNaN(bi)) return false;
    start = ai;
    end = bi;
  } else {
    const n = parseInt(basePart, 10);
    if (Number.isNaN(n)) return false;
    if (stepStr) {
      // "N/M" — step from N to range.max
      start = n;
      end = range.max;
    } else {
      // Single value
      if (n < range.min || n > range.max) {
        // For dow, accept 7 as Sunday by normalising below
        if (!(range === RANGES.dow && n === 7)) return false;
      }
      out.add(n === 7 && range === RANGES.dow ? 0 : n);
      return true;
    }
  }

  if (start < range.min || end > range.max || start > end) {
    // Special case: dow=7 normalises to 0
    if (range === RANGES.dow && end === 7) end = 0;
    else return false;
  }
  for (let v = start; v <= end; v += step) {
    out.add(v === 7 && range === RANGES.dow ? 0 : v);
  }
  return true;
}

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  doms: Set<number>;
  months: Set<number>;
  dows: Set<number>;
}

export function parseCron(expr: string): ParsedCron | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minutes = parseField(parts[0], RANGES.min);
  const hours = parseField(parts[1], RANGES.hour);
  const doms = parseField(parts[2], RANGES.dom);
  const months = parseField(parts[3], RANGES.month);
  const dows = parseField(parts[4], RANGES.dow);
  if (!minutes || !hours || !doms || !months || !dows) return null;
  return { minutes, hours, doms, months, dows };
}

/**
 * Compute the next time after `from` when this cron expression fires.
 * Returns null if the expression is invalid or no match found within
 * lookahead (~5 years).
 *
 * Cron has an OR-of-restrictions semantic on day fields: if BOTH dom
 * and dow are constrained (not "*"), a date matches when EITHER
 * matches. If only one is constrained, only that one must match.
 * (This is the Vixie-cron behaviour; Temporal cron honours it.)
 */
export function nextFireTime(expr: string, from: Date): Date | null {
  const parsed = parseCron(expr);
  if (!parsed) return null;

  // Detect whether dom and dow are both restricted (not full ranges)
  // — Vixie OR semantic kicks in only when both are constrained.
  const domConstrained = parsed.doms.size < 31;
  const dowConstrained = parsed.dows.size < 7;
  const bothDayConstrained = domConstrained && dowConstrained;

  // Walk forward from `from + 1 minute` minute by minute, but skip days
  // we know don't qualify. Hard cap at 5 years of minutes to bound the
  // worst case.
  const cap = 5 * 366 * 24 * 60;
  const start = new Date(Math.ceil((from.getTime() + 1) / 60_000) * 60_000);
  // Use UTC components — Temporal cron is UTC unless TZ is configured
  // at the schedule level; we match Vixie semantics in UTC by default.
  let cursor = new Date(Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate(),
    start.getUTCHours(),
    start.getUTCMinutes(),
    0, 0,
  ));

  for (let i = 0; i < cap; i++) {
    const minute = cursor.getUTCMinutes();
    const hour = cursor.getUTCHours();
    const dom = cursor.getUTCDate();
    const month = cursor.getUTCMonth() + 1;
    const dow = cursor.getUTCDay();

    let dateOk: boolean;
    if (bothDayConstrained) {
      dateOk = parsed.doms.has(dom) || parsed.dows.has(dow);
    } else {
      dateOk = parsed.doms.has(dom) && parsed.dows.has(dow);
    }
    if (
      parsed.months.has(month) &&
      dateOk &&
      parsed.hours.has(hour) &&
      parsed.minutes.has(minute)
    ) {
      return cursor;
    }

    // Coarse-grain skip: if the month doesn't match, jump to first of
    // the next month. If the day doesn't match, jump to next day at
    // 00:00. Otherwise jump by 1 minute.
    if (!parsed.months.has(month)) {
      cursor = new Date(Date.UTC(
        cursor.getUTCFullYear(),
        cursor.getUTCMonth() + 1,
        1, 0, 0, 0, 0,
      ));
    } else if (!dateOk) {
      cursor = new Date(Date.UTC(
        cursor.getUTCFullYear(),
        cursor.getUTCMonth(),
        cursor.getUTCDate() + 1,
        0, 0, 0, 0,
      ));
    } else if (!parsed.hours.has(hour)) {
      cursor = new Date(Date.UTC(
        cursor.getUTCFullYear(),
        cursor.getUTCMonth(),
        cursor.getUTCDate(),
        cursor.getUTCHours() + 1,
        0, 0, 0,
      ));
    } else {
      cursor = new Date(cursor.getTime() + 60_000);
    }
  }
  return null;
}
