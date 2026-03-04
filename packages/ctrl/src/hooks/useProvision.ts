import { useState, useCallback } from "react";
import { provision } from "../infra/provisioner.js";
import type { InstanceConfig, ProvisioningState } from "../data/types.js";

export function useProvision() {
  const [state, setState] = useState<ProvisioningState | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const start = useCallback(async (config: InstanceConfig) => {
    setIsRunning(true);
    const result = await provision(config, (newState) => {
      setState({ ...newState });
    });
    setState(result);
    setIsRunning(false);
    return result;
  }, []);

  return { state, isRunning, start };
}
