/** Poll state JSONs → ToolStats. */

import { useState, useEffect, useCallback } from 'react';
import type { ToolStats } from '../data/types.js';
import { readStats } from '../data/state-reader.js';

export function useStatePoller(
  dataDir: string,
  intervalMs: number = 10000,
): ToolStats {
  const [stats, setStats] = useState<ToolStats>(() => readStats(dataDir));

  const poll = useCallback(() => {
    setStats(readStats(dataDir));
  }, [dataDir]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, intervalMs);
    return () => clearInterval(id);
  }, [poll, intervalMs]);

  return stats;
}
