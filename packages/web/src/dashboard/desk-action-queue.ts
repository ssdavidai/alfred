// Strict serial queue for /desk action submits.
//
// Sir's principle (2026-05-12): even if he mash-clicks Delegate / Defer
// / Done / Noise on 10 cards in a row, the *server-side* work for those
// clicks drains one cycle at a time. The optimistic UI (markHandled)
// still runs synchronously — the card disappears from the queue
// immediately on click — but the audit + source-specific mutations
// queue.
//
// Why this matters: a single Desk action fires 3 POSTs (recordDecision
// + recordDeskAction + the per-source mutation). Mash-clicking 10
// cards = up to 30 parallel POSTs hitting ctrl-api at once. ctrl-api's
// vault PATCH endpoint shells out to the alfred CLI via `docker exec`
// (single-flight under _withVaultPathLock), which holds 2-12 seconds.
// Bursts blow cloudflared's connection queue to localhost:3100, which
// surfaces in the browser as 502s from the preview SaaS's
// tenantProxy.ts wrapping the failed fetch.
//
// The chain is module-level (survives navigation) — there is no per-page
// state to maintain. Tasks failures are isolated: if one fn rejects,
// the next still runs.

let chain: Promise<unknown> = Promise.resolve();

export function enqueueDeskAction<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(
    () => fn(),
    () => fn(),
  );
  chain = next.catch(() => undefined);
  return next;
}
