/** Poll workers.json → WorkerInfo[]. */

import { useState, useEffect, useCallback } from 'react';
import type { WorkerInfo } from '../data/types.js';
import { readWorkersJson, readWorkersStartedAt } from '../data/state-reader.js';

export function useWorkerStatus(
  dataDir: string,
  intervalMs: number = 1000,
): { workers: WorkerInfo[]; startedAt: string } {
  const [workers, setWorkers] = useState<WorkerInfo[]>([]);
  const [startedAt, setStartedAt] = useState('');

  const poll = useCallback(() => {
    setWorkers(readWorkersJson(dataDir));
    setStartedAt(readWorkersStartedAt(dataDir));
  }, [dataDir]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, intervalMs);
    return () => clearInterval(id);
  }, [poll, intervalMs]);

  return { workers, startedAt };
}
