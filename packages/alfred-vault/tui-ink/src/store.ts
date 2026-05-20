/** Central state — React context provider. */

import { createContext, useContext } from 'react';
import type { WorkerFeed, MutationEntry, ToolStats, WorkerInfo, TimeSeriesData } from './data/types.js';

export interface AppState {
  feeds: Record<string, WorkerFeed>;
  mutations: MutationEntry[];
  stats: ToolStats;
  workers: WorkerInfo[];
  uptime: string;
  version: string;
  timeSeries: TimeSeriesData;
}

export const StoreContext = createContext<AppState>({
  feeds: {},
  mutations: [],
  stats: {
    curatorProcessed: 0, curatorLastRun: '',
    janitorTracked: 0, janitorIssues: 0, janitorSweeps: 0,
    distillerSources: 0, distillerLearnings: 0, distillerRuns: 0,
    surveyorTracked: 0, surveyorClusters: 0, surveyorLastRun: '',
  },
  workers: [],
  uptime: '--',
  version: '',
  timeSeries: {
    activityRate: [],
    perToolActivity: {},
    llmCallRate: [],
    errorRate: [],
    mutationRate: [],
  },
});

export function useStore(): AppState {
  return useContext(StoreContext);
}
