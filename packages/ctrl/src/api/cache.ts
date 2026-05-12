// In-process TTL cache for read endpoints that re-walk the vault on
// every request. ctrl-api is single-event-loop Node — under the Desk's
// ~12-parallel-query fan-out plus the alfred-learn background workers,
// the synchronous walk+readRecord cycle on a multi-thousand-record vault
// would serialise on the event loop and individual requests would tip
// past Wasp's tenant-proxy timeout, producing 504 storms on every click.
//
// Strategy:
//   - Keyed in-memory cache with a short TTL (a few seconds).
//   - On miss, the compute promise is stored *before* it resolves so
//     concurrent callers await the same in-flight work (thundering-herd
//     coalescing). With a 12-parallel-request burst, only one walk
//     actually runs.
//   - The TTL is short enough (2-5 s) that the principal never sees
//     meaningfully stale data — the Desk polls/refetches on every
//     action anyway, so freshness arrives on the next click.
//   - Write paths inside ctrl-api (POST/PATCH/DELETE on vault records)
//     should call `invalidate()` to bust the cache immediately when a
//     mutation lands; external writes (alfred-learn workers writing
//     through ctrl-api PATCH) get the same invalidation for free.

type Entry<T> = {
  value: T | undefined;
  expiresAt: number;
  inflight: Promise<T> | null;
};

export interface TtlCache<T> {
  /** Return the cached value if fresh, else run computeFn and cache it.
   *  Concurrent callers with the same key share one inflight promise. */
  get(key: string, computeFn: () => Promise<T> | T): Promise<T>;
  /** Bust a specific key, or all keys if no key is given. */
  invalidate(key?: string): void;
}

export function ttlCache<T>(opts: { ttlMs: number }): TtlCache<T> {
  const store = new Map<string, Entry<T>>();

  return {
    async get(key, computeFn): Promise<T> {
      const now = Date.now();
      const existing = store.get(key);

      // Fresh hit.
      if (existing && existing.value !== undefined && existing.expiresAt > now) {
        return existing.value;
      }
      // In-flight compute — coalesce.
      if (existing?.inflight) {
        return existing.inflight;
      }

      // Miss — start the compute and let concurrent callers await it.
      const promise = Promise.resolve().then(() => computeFn());
      store.set(key, {
        value: existing?.value,
        expiresAt: existing?.expiresAt ?? 0,
        inflight: promise,
      });

      try {
        const value = await promise;
        store.set(key, {
          value,
          expiresAt: Date.now() + opts.ttlMs,
          inflight: null,
        });
        return value;
      } catch (err) {
        // Drop the entry on error so the next caller retries cleanly.
        store.delete(key);
        throw err;
      }
    },

    invalidate(key) {
      if (key === undefined) {
        store.clear();
      } else {
        store.delete(key);
      }
    },
  };
}
