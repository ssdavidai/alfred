/** Security boundary for Express proxy trust. A request may trust only the configured number of addresses nearest the application. */
export function boundedProxyTrust(hops: number) {
  if (!Number.isSafeInteger(hops) || hops < 0 || hops > 4) {
    throw new Error("proxy trust hops must be an integer between 0 and 4");
  }
  return (_address: string, hop: number) => hop < hops;
}
