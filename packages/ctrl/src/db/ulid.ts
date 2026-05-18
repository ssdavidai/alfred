// Crockford-base32 ULID generator.
//
// A ULID is a 26-char identifier: the first 10 chars encode the millisecond
// timestamp, the last 16 are randomness. Lexicographically sortable by
// creation time — exactly what every state.db / ingest.db `id` column wants.
//
// Generated inline rather than pulling the `ulid` npm package: ctrl-api ships
// with zero runtime dependencies on purpose (build.mjs bundles, node:sqlite is
// built in). This is byte-identical to the canonical encoding and matches the
// generator already used by routes/stateChanges.ts.

import crypto from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now()): string {
  let timePart = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[t % 32] + timePart;
    t = Math.floor(t / 32);
  }
  const randBytes = crypto.randomBytes(10);
  let acc = 0n;
  for (const b of randBytes) {
    acc = (acc << 8n) | BigInt(b);
  }
  let randPart = "";
  for (let i = 0; i < 16; i++) {
    randPart = CROCKFORD[Number(acc & 31n)] + randPart;
    acc >>= 5n;
  }
  return timePart + randPart;
}
