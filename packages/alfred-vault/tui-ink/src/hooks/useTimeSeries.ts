/** Samples metrics every interval, maintains rolling window for sparklines. */

import { useState, useEffect, useRef } from 'react';
import type { WorkerFeed, MutationEntry, TimeSeriesData } from '../data/types.js';
import { TOOLS, TIME_SERIES_INTERVAL_MS, TIME_SERIES_MAX_SAMPLES } from '../data/constants.js';

function emptyTimeSeries(): TimeSeriesData {
  const perToolActivity: Record<string, number[]> = {};
  for (const t of TOOLS) perToolActivity[t] = [];
  return {
    activityRate: [],
    perToolActivity,
    llmCallRate: [],
    errorRate: [],
    mutationRate: [],
  };
}

function pushSample(arr: number[], value: number): number[] {
  const next = [...arr, value];
  if (next.length > TIME_SERIES_MAX_SAMPLES) next.shift();
  return next;
}

export function useTimeSeries(
  feeds: Record<string, WorkerFeed>,
  mutations: MutationEntry[],
): TimeSeriesData {
  const [ts, setTs] = useState<TimeSeriesData>(emptyTimeSeries);

  // Track previous counts to compute deltas
  const prevRef = useRef<{
    feedCounts: Record<string, number>;
    llmCalls: number;
    errors: number;
    mutationCount: number;
  }>({
    feedCounts: {},
    llmCalls: 0,
    errors: 0,
    mutationCount: 0,
  });

  useEffect(() => {
    const id = setInterval(() => {
      const prev = prevRef.current;

      // Total activity across all tools
      let totalEntries = 0;
      let totalLlmCalls = 0;
      let totalErrors = 0;
      const perToolDeltas: Record<string, number> = {};

      for (const tool of TOOLS) {
        const feed = feeds[tool];
        if (!feed) {
          perToolDeltas[tool] = 0;
          continue;
        }

        const currentCount = feed.entries.length;
        const prevCount = prev.feedCounts[tool] ?? 0;
        const delta = Math.max(0, currentCount - prevCount);
        perToolDeltas[tool] = delta;
        totalEntries += delta;

        totalLlmCalls += feed.llmCalls;
        totalErrors += feed.errors;
      }

      const llmDelta = Math.max(0, totalLlmCalls - prev.llmCalls);
      const errorDelta = Math.max(0, totalErrors - prev.errors);
      const mutDelta = Math.max(0, mutations.length - prev.mutationCount);

      // Update prev
      const newFeedCounts: Record<string, number> = {};
      for (const tool of TOOLS) {
        newFeedCounts[tool] = feeds[tool]?.entries.length ?? 0;
      }
      prevRef.current = {
        feedCounts: newFeedCounts,
        llmCalls: totalLlmCalls,
        errors: totalErrors,
        mutationCount: mutations.length,
      };

      setTs(prev => {
        const next: TimeSeriesData = {
          activityRate: pushSample(prev.activityRate, totalEntries),
          perToolActivity: { ...prev.perToolActivity },
          llmCallRate: pushSample(prev.llmCallRate, llmDelta),
          errorRate: pushSample(prev.errorRate, errorDelta),
          mutationRate: pushSample(prev.mutationRate, mutDelta),
        };
        for (const tool of TOOLS) {
          next.perToolActivity[tool] = pushSample(
            prev.perToolActivity[tool] ?? [],
            perToolDeltas[tool] ?? 0,
          );
        }
        return next;
      });
    }, TIME_SERIES_INTERVAL_MS);

    return () => clearInterval(id);
  }, [feeds, mutations]);

  return ts;
}
