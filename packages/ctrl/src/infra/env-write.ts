/**
 * Pure helpers for safely writing KEY=VALUE pairs to a tenant's
 * /opt/alfred/compose/.env file via SSH.
 *
 * Extracted to its own module so it can be unit-tested without dragging
 * provisioner.ts's full transitive dependency graph (Hetzner client,
 * Cloudflare client, .njk templates, etc.) into the test loader.
 *
 * Background — issue #681:
 *   The AgentPhone provisioning step (PR #221) wrote four env vars by
 *   joining them into a single string with `\n`, then passing that as the
 *   only argument to `printf '%s'`. printf's `%s` does NOT interpret
 *   backslash escapes inside its arguments — only inside the format string.
 *   Result: every newer-wave tenant got `/opt/alfred/compose/.env` with one
 *   physical line containing literal backslash-n characters separating the
 *   four KEY=VALUE pairs, and only TENANT_ID parsed.
 *
 *   The earlier #552 fix for `writeTenantEnv` (the plane-bootstrap path)
 *   solved the same problem by switching to `printf '%s\n' arg1 arg2 …`
 *   where `\n` lives in the format string and printf re-applies it once
 *   per argument. We now route AgentPhone through the same helper.
 */

/**
 * Build the shell command that strips existing assignments for each key in
 * `entries`, then appends new KEY='VALUE' lines, each on its own physical
 * line. Returns `null` if `entries` is empty.
 *
 * Invariants the consumer can rely on:
 *   1. Every key gets its own `'KEY=VALUE'` printf argument — no joined
 *      strings with embedded backslash-n.
 *   2. The format string is `'%s\n'`, which printf interprets to insert a
 *      real newline after each argument.
 *   3. Single quotes inside values are escaped via the bash `'"'"'` idiom.
 *   4. The write is atomic: sed-strip → tmp file → mv → chmod 600.
 */
export function buildEnvWriteCommand(
  envPath: string,
  entries: Record<string, string>,
): string | null {
  const keys = Object.keys(entries);
  if (keys.length === 0) return null;
  // Build a sed script that deletes existing assignments, then append.
  const sedDeletes = keys
    .map((k) => `-e ${JSON.stringify(`/^${k}=/d`)}`)
    .join(" ");
  // printf '%s\n' repeats the format string once per argument, emitting each
  // on its own line. NEVER bury a newline inside an individual argument —
  // printf '%s' does not interpret escape sequences in arguments. See #552
  // and #681 for the bug pattern.
  const printfArgs = keys
    .map((k) => {
      // Shell-safe single-quoting for the value side. The only forbidden char
      // is a literal single quote; we replace `'` with `'"'"'`.
      const v = entries[k].replace(/'/g, `'"'"'`);
      return JSON.stringify(`${k}='${v}'`);
    })
    .join(" ");
  // Use a tmp file + mv to keep the write atomic. sed -i on Ubuntu creates a
  // backup by default only with -i''; explicitly omit the backup suffix.
  // First-write case: when the target .env doesn't exist yet (fresh
  // tenant getting Vexa retrofitted, any new compose project), the sed
  // strip and the cp fallback both fail and `set -e` aborts the whole
  // command. Touching the path first guarantees an empty starting file
  // the sed step can operate on. The dirname mkdir -p covers tenants
  // where the parent directory was just created earlier in the same
  // SSH transcript.
  return `set -e; mkdir -p $(dirname ${envPath}); touch ${envPath}; _tmp=$(mktemp); sed ${sedDeletes} ${envPath} > "$_tmp"; printf '\\n' >> "$_tmp"; printf '%s\\n' ${printfArgs} >> "$_tmp"; mv "$_tmp" ${envPath}; chmod 600 ${envPath}`;
}
