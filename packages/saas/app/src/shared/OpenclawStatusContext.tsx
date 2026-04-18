/**
 * OpenclawStatusContext — tracks whether the tenant's openclaw gateway is
 * currently restarting to pick up a config change (e.g. after auto-config of
 * a new Composio integration added `ctrl_composio_execute` to
 * `gateway.tools.allow`).
 *
 * During that window (~40s on a cx53) any request to openclaw returns a
 * Cloudflare 502. Rather than leak that to the user, the Integrations page
 * marks the tenant as reconfiguring and `DashboardLayout` renders a banner
 * and disables the "Open Alfred" chat link until the gateway is ready.
 *
 * State is kept in-memory per tab — refreshing loses it, which is fine:
 * a page reload hits the same 502 window briefly and then resolves.
 */
import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";

interface OpenclawStatusValue {
  reconfiguringUntil: Date | null;
  reconfiguringLabel: string | null;
  /** Mark the tenant as reconfiguring. `untilMs` defaults to 60_000 (60s). */
  markReconfiguring: (label: string, untilMs?: number) => void;
  clearReconfiguring: () => void;
}

const OpenclawStatusContext = createContext<OpenclawStatusValue | null>(null);

const DEFAULT_RESTART_WINDOW_MS = 60_000;

export function OpenclawStatusProvider({ children }: { children: ReactNode }) {
  const [reconfiguringUntil, setReconfiguringUntil] = useState<Date | null>(null);
  const [reconfiguringLabel, setReconfiguringLabel] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearReconfiguring = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setReconfiguringUntil(null);
    setReconfiguringLabel(null);
  }, []);

  const markReconfiguring = useCallback(
    (label: string, untilMs: number = DEFAULT_RESTART_WINDOW_MS) => {
      const until = new Date(Date.now() + untilMs);
      setReconfiguringUntil(until);
      setReconfiguringLabel(label);
      if (timerRef.current) clearTimeout(timerRef.current);
      // Safety net: always clear after the window elapses so a stuck banner
      // never blocks the UI. The readiness poll should clear it earlier.
      timerRef.current = setTimeout(() => {
        setReconfiguringUntil(null);
        setReconfiguringLabel(null);
        timerRef.current = null;
      }, untilMs + 5_000);
    },
    [],
  );

  return (
    <OpenclawStatusContext.Provider
      value={{
        reconfiguringUntil,
        reconfiguringLabel,
        markReconfiguring,
        clearReconfiguring,
      }}
    >
      {children}
    </OpenclawStatusContext.Provider>
  );
}

export function useOpenclawStatus(): OpenclawStatusValue {
  const ctx = useContext(OpenclawStatusContext);
  if (!ctx) {
    throw new Error("useOpenclawStatus must be used inside OpenclawStatusProvider");
  }
  return ctx;
}
