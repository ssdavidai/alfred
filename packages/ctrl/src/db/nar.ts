// NAR v1 — pure computation, no I/O. Issue #570.
// NAR = displaced − mess_bill − interruption (hours, one decimal).
export interface RateTable {
  decision_noise_min: number;     // suppression; conservative 30s
  decision_done_min: number;      // context Alfred surfaced, not the doing
  decision_delegate_min: number;  // Alfred performed the work
  decision_defer_min: number;     // tracking only
  decision_take_mine_min: number; // principal did it; earns nothing
  interruption_min: number;       // context-switch cost per unsolicited outbound
  gap_threshold_min: number;      // gap > this ends a burst
  burst_floor_min: number;        // isolated click is not zero
}
export const DEFAULT_RATES: RateTable = {
  decision_noise_min: 0.5, decision_done_min: 3, decision_delegate_min: 10,
  decision_defer_min: 1, decision_take_mine_min: 0, interruption_min: 2,
  gap_threshold_min: 5, burst_floor_min: 2,
};
export interface DecisionCounts {
  noise: number; done: number; delegate: number; defer: number; take_mine: number;
}
export interface NarStatement {
  month: string;
  displaced:    { total_hours: number; counts: DecisionCounts };
  mess_bill:    { total_hours: number; burst_count: number; event_count: number };
  interruption: { total_hours: number; count: number };
  nar: number; // negative is valid and honest
  rates: RateTable; // exact table used — verify arithmetic against this
}

/** Cluster sorted timestamps into bursts. Gap > gapMs ends a burst; span floored at floorMs. */
export function clusterBursts(
  sortedTs: Date[], gapMs: number, floorMs: number,
): { totalMs: number; burstCount: number } {
  if (sortedTs.length === 0) return { totalMs: 0, burstCount: 0 };
  let totalMs = 0, burstCount = 0, start = sortedTs[0], end = sortedTs[0];
  for (let i = 1; i < sortedTs.length; i++) {
    if (sortedTs[i].getTime() - end.getTime() <= gapMs) { end = sortedTs[i]; }
    else {
      totalMs += Math.max(end.getTime() - start.getTime(), floorMs);
      burstCount++;
      start = end = sortedTs[i];
    }
  }
  return { totalMs: totalMs + Math.max(end.getTime() - start.getTime(), floorMs), burstCount: burstCount + 1 };
}

export function computeNarStatement(
  month: string, decisions: DecisionCounts, principalTs: Date[],
  interruptionCount: number, rates: RateTable,
): NarStatement {
  const displacedMin =
    decisions.noise * rates.decision_noise_min + decisions.done * rates.decision_done_min +
    decisions.delegate * rates.decision_delegate_min + decisions.defer * rates.decision_defer_min +
    decisions.take_mine * rates.decision_take_mine_min;
  const { totalMs, burstCount } = clusterBursts(
    principalTs, rates.gap_threshold_min * 60_000, rates.burst_floor_min * 60_000);
  const messBillMin = totalMs / 60_000, interruptionMin = interruptionCount * rates.interruption_min;
  const toH = (m: number) => +((m / 60).toFixed(1));
  return {
    month,
    displaced:    { total_hours: toH(displacedMin), counts: decisions },
    mess_bill:    { total_hours: toH(messBillMin), burst_count: burstCount, event_count: principalTs.length },
    interruption: { total_hours: toH(interruptionMin), count: interruptionCount },
    nar: toH(displacedMin - messBillMin - interruptionMin), rates,
  };
}
