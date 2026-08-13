// ============================================================================
// engagedTime.ts — derive principal engaged time from event timestamps.
// Issue #563 sequence item 1.
//
// Engaged time is a property of a *period*, not of a single decision.
// Twelve clicks inside six minutes is six minutes of attention, not twelve
// separate durations. This module provides the derivation primitive.
//
// The consumer is the nightly recap workflow (Lane II, #563 item 4).
// Shipping the derivation without the consumer is intentional — once the
// recap workflow lands it will import clusterBursts from here.
// ============================================================================

/** Result of clustering timestamps into interaction bursts. */
export interface BurstResult {
  /** Total engaged milliseconds — burst spans each floored at floorMs. */
  totalMs: number;
  /** Number of distinct bursts detected. */
  burstCount: number;
}

/**
 * Cluster timestamps into interaction bursts and return total engaged ms.
 *
 * Algorithm
 * ---------
 * - Input is sorted internally (a copy — the caller's array is not mutated).
 *   Accepting unsorted input is the safer contract: an unsorted array would
 *   silently produce wrong results, so sorting once here costs O(n log n)
 *   but eliminates the silent-wrong-answer class of bugs.
 * - Consecutive events separated by ≤ gapMs belong to one burst.
 * - Each burst contributes max(span, floorMs) to the total, so an isolated
 *   event is not scored as zero.
 *
 * @param ts      Event timestamps (order does not matter — sorted internally).
 * @param gapMs   Gap threshold in ms; a gap larger than this ends a burst.
 * @param floorMs Minimum contribution per burst in ms.
 */
export function clusterBursts(
  ts: Date[],
  gapMs: number,
  floorMs: number,
): BurstResult {
  if (ts.length === 0) return { totalMs: 0, burstCount: 0 };

  // Sort a copy so we never mutate the caller's array.
  const sorted = ts.slice().sort((a, b) => a.getTime() - b.getTime());

  let totalMs = 0;
  let burstCount = 0;
  let start = sorted[0];
  let end = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].getTime() - end.getTime();
    if (gap <= gapMs) {
      end = sorted[i]; // extend the current burst
    } else {
      totalMs += Math.max(end.getTime() - start.getTime(), floorMs);
      burstCount++;
      start = sorted[i];
      end = sorted[i];
    }
  }
  // Close the final burst.
  totalMs += Math.max(end.getTime() - start.getTime(), floorMs);
  burstCount++;

  return { totalMs, burstCount };
}
