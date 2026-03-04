import { useState, useCallback } from "react";
import { exec as sshExec } from "../infra/ssh.js";
import type { SSHResult } from "../infra/ssh.js";

export function useSSH() {
  const [result, setResult] = useState<SSHResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (host: string, keyPath: string, command: string) => {
      setIsRunning(true);
      setError(null);
      try {
        const res = await sshExec(host, keyPath, command);
        setResult(res);
        return res;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        return null;
      } finally {
        setIsRunning(false);
      }
    },
    []
  );

  return { result, isRunning, error, run };
}
