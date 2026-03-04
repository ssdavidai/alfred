import { useState, useEffect } from "react";
import { listInstances } from "../db/queries.js";
import type { Instance, InstanceStatus } from "../data/types.js";

export function useInstances(
  statusFilter?: InstanceStatus,
  pollMs = 5000
): { instances: Instance[]; refresh: () => void } {
  const [instances, setInstances] = useState<Instance[]>([]);

  const refresh = () => {
    setInstances(listInstances(statusFilter));
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, pollMs);
    return () => clearInterval(id);
  }, [statusFilter, pollMs]);

  return { instances, refresh };
}
