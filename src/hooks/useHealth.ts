import { useState, useEffect } from "react";
import { onHealthUpdate } from "../monitoring/health.js";
import type { HealthStatus } from "../data/types.js";

export function useHealth(): Map<number, HealthStatus> {
  const [healthMap, setHealthMap] = useState<Map<number, HealthStatus>>(
    new Map()
  );

  useEffect(() => {
    const unsubscribe = onHealthUpdate((instanceId, status) => {
      setHealthMap((prev) => {
        const next = new Map(prev);
        next.set(instanceId, status);
        return next;
      });
    });

    return unsubscribe;
  }, []);

  return healthMap;
}
