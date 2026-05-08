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
 * Characters that require the value to be quoted in the .env file.
 * If a value contains none of these, we can write `KEY=VALUE` plain.
 *
 * Why care about avoiding quotes:
 *   docker-compose's env_file parser handling of surrounding single/double
 *   quotes is version-dependent — older docker compose strips them, newer
 *   versions sometimes don't. Bash `source`-ing the file always strips.
 *   If a downstream consumer (e.g. vault-cli's serve.sh checking
 *   `[ -n "$BW_USER" ]` or `bw login "$BW_USER"`) reads the env from a
 *   shell that DIDN'T strip, it gets a literal-quoted string — and any
 *   crypto derived from it (e.g. PBKDF2 with email-as-salt) ends up
 *   computed from the wrong value.
 *
 *   By only quoting when actually necessary, the common case of
 *   alphanumeric secrets / UUIDs / emails / URLs is unambiguous: the
 *   value is exactly the bytes between `=` and the newline, no
 *   stripping decisions to make.
 *
 *   Surfaced 2026-05-08 on daveszab tenant: BW_USER='daveszab@gmail.com'
 *   appeared in .env, vault-cli failed PBKDF2 verification because
 *   different consumers disagreed on whether the quotes were part of
 *   the value.
 */
const SHELL_SPECIAL_RE = /[\s$`"\\\n#=*?\[\](){}|&;<>!]/;

function formatEnvLine(key: string, value: string): string {
  if (value === "" || SHELL_SPECIAL_RE.test(value)) {
    // Single-quote with the standard `'"'"'` escape for embedded quotes.
    const escaped = value.replace(/'/g, `'"'"'`);
    return `${key}='${escaped}'`;
  }
  // Plain — no quoting needed, value is unambiguous.
  return `${key}=${value}`;
}

/**
 * Build the shell command that strips existing assignments for each key in
 * `entries`, then appends new KEY=VALUE lines, each on its own physical
 * line. Returns `null` if `entries` is empty.
 *
 * Invariants the consumer can rely on:
 *   1. Every key gets its own `KEY=VALUE` printf argument — no joined
 *      strings with embedded backslash-n.
 *   2. The format string is `'%s\n'`, which printf interprets to insert a
 *      real newline after each argument.
 *   3. Values are written UNQUOTED when they contain no shell-special
 *      characters; otherwise wrapped in single quotes with the
 *      `'"'"'` escape for embedded quotes. This avoids the docker-compose
 *      quote-stripping ambiguity (see formatEnvLine docs above).
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
    .map((k) => JSON.stringify(formatEnvLine(k, entries[k])))
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
