// System routes — surface the tenant VM's basic shape (SSH, container
// names) for in-app cards that need to display "how to connect" without
// hard-coding host/key info in the SPA.
//
// Consumers today:
//   * /channels Terminal card (Sir #8, then self-contained rework Sir
//     2026-05-26): GET /ssh-info (status string) + GET /ssh-keys (full
//     list with fingerprints), POST /ssh-keys (add a pubkey OR generate
//     a fresh ed25519 keypair on the VM), POST /ssh-keys/revoke (drop
//     a non-bootstrap line by fingerprint).
//
// The pubkey store is the VM's own /root/.ssh/authorized_keys, bind-
// mounted RW into this container. That file is the source of truth —
// no shadow state in state.db.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { addRoute } from "../server.js";
import {
  sendJson,
  ValidationError,
  NotFoundError,
  ConflictError,
  ExecError,
} from "../errors.js";

const HERMES_CONTAINER = "alfred-black-hermes-1";
const HERMES_EXEC_CMD = `docker exec -it ${HERMES_CONTAINER} hermes`;
const DEFAULT_AUTHORIZED_KEYS = "/root/.ssh/authorized_keys";

function keysPath(): string {
  return process.env.AUTHORIZED_KEYS_PATH || DEFAULT_AUTHORIZED_KEYS;
}

// ---------------------------------------------------------------------------
// Pubkey parsing
// ---------------------------------------------------------------------------
//
// An OpenSSH `authorized_keys` line looks like:
//   <type> <base64-blob> <comment?>
// where <type> is ssh-ed25519 / ssh-rsa / ecdsa-sha2-nistpXXX /
// sk-ssh-ed25519@openssh.com. Authorized-keys options (command="...",
// from="...", no-pty, …) appear BEFORE <type> when present; cloud-init
// doesn't use them and we don't accept them in user-supplied input
// because they're a privilege-escalation surface in a UI textarea.
// Existing options on lines we read back are tolerated by parsing
// from-the-end (matching the rightmost type token).

const PUBKEY_LINE_RE =
  /(?:^|\s)(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com)\s+([A-Za-z0-9+/=]{20,})(?:\s+(.+))?\s*$/;

// Stricter form: ONLY <type> <blob> <comment?> — used to validate user
// input (no leading options allowed).
const PUBKEY_INPUT_RE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com)\s+([A-Za-z0-9+/=]{20,})(?:\s+(.+))?$/;

interface ParsedKey {
  /** Trimmed full line as it appears on disk. */
  raw: string;
  type: string;
  /** Base64 blob (no whitespace). */
  blob: string;
  /** Optional comment; "" if none. */
  comment: string;
  /** OpenSSH-style SHA256 fingerprint: "SHA256:<b64-no-pad>". */
  fingerprint: string;
}

function fingerprintForBlob(blobB64: string): string {
  const buf = Buffer.from(blobB64, "base64");
  const sha = crypto.createHash("sha256").update(buf).digest("base64");
  return "SHA256:" + sha.replace(/=+$/, "");
}

function parseLine(line: string, strict = false): ParsedKey | null {
  const t = line.trim();
  if (!t || t.startsWith("#")) return null;
  const m = (strict ? PUBKEY_INPUT_RE : PUBKEY_LINE_RE).exec(t);
  if (!m) return null;
  const [, type, blob, comment] = m;
  // Validate the blob is real base64 of a reasonable length.
  let buf: Buffer;
  try {
    buf = Buffer.from(blob, "base64");
  } catch {
    return null;
  }
  if (buf.length < 32) return null;
  return {
    raw: t,
    type,
    blob,
    comment: (comment ?? "").trim(),
    fingerprint: fingerprintForBlob(blob),
  };
}

interface InstalledKey extends ParsedKey {
  /** True for the FIRST usable key in the file — the bootstrap key the
   *  operator was provisioned with. The UI refuses to revoke it. */
  bootstrap: boolean;
}

function parseAuthorizedKeys(raw: string): InstalledKey[] {
  const lines = raw.split(/\r?\n/);
  const parsed: ParsedKey[] = [];
  for (const line of lines) {
    const k = parseLine(line);
    if (k) parsed.push(k);
  }
  return parsed.map((k, i) => ({ ...k, bootstrap: i === 0 }));
}

// ---------------------------------------------------------------------------
// File IO
// ---------------------------------------------------------------------------

function readAuthorized(): string {
  try {
    return fs.readFileSync(keysPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Atomic-ish write: stage to a sibling tmp file (same mount → same FS so
 * rename(2) is atomic), then rename over the target. The bind mount is
 * a bind mount of a single file, so writeFile+rename keeps the inode the
 * same from the host's perspective.
 *
 * If the file is bind-mounted from the host, we cannot rename onto it
 * directly across the mount boundary — Docker bind-mounts a single file
 * by inode and rename(2) fails with EBUSY. Fall back to a direct write
 * in that case.
 */
function writeAuthorizedKeys(content: string): void {
  const p = keysPath();
  const dir = path.dirname(p);
  const tmp = path.join(dir, `.authorized_keys.tmp.${process.pid}`);
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch (err) {
    // Bind-mounted single file: rename onto it fails (EBUSY / EXDEV).
    // Direct write is fine — the file already exists, we just truncate.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    if (
      (err as NodeJS.ErrnoException).code === "EBUSY" ||
      (err as NodeJS.ErrnoException).code === "EXDEV" ||
      (err as NodeJS.ErrnoException).code === "EINVAL"
    ) {
      fs.writeFileSync(p, content, { mode: 0o600 });
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// ssh-keygen wrapper
// ---------------------------------------------------------------------------

interface GeneratedKey {
  pubkey: string;
  privateKey: string;
  fingerprint: string;
}

function generateEd25519(comment: string): GeneratedKey {
  if (comment.length > 80 || /[\r\n]/.test(comment)) {
    throw new ValidationError("comment must be ≤80 chars and single-line");
  }
  const safeComment = comment.trim() || `alfred-generated-${Date.now()}`;
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "alfred-ssh-"));
  const privPath = path.join(tmpdir, "k");
  const pubPath = `${privPath}.pub`;
  try {
    try {
      execFileSync(
        "ssh-keygen",
        ["-q", "-t", "ed25519", "-N", "", "-C", safeComment, "-f", privPath],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
      throw new ExecError(`ssh-keygen failed: ${(err as Error).message}`, stderr);
    }
    const priv = fs.readFileSync(privPath, "utf8");
    const pub = fs.readFileSync(pubPath, "utf8").trim();
    const parsed = parseLine(pub, true);
    if (!parsed) throw new ExecError("ssh-keygen produced an unparseable pubkey", pub);
    return { pubkey: pub, privateKey: priv, fingerprint: parsed.fingerprint };
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerSystemRoutes(): void {
  // Sir #8 — unchanged shape (TerminalCard.deriveTerminalCardState reads
  // .pubkey/.host/.user/.port/.hermes_exec). New /ssh-keys provides the
  // full list; this route is kept for back-compat.
  addRoute("GET", "/api/v1/system/ssh-info", async ({ res }) => {
    const host = process.env.DOMAIN || process.env.TENANT_DOMAIN || "localhost";
    const parsed = parseAuthorizedKeys(readAuthorized());
    const firstPubkey = parsed[0]?.raw ?? null;
    const body: Record<string, unknown> = {
      host,
      port: 22,
      user: "root",
      pubkey: firstPubkey,
      container: HERMES_CONTAINER,
      exec_command: HERMES_EXEC_CMD,
    };
    if (!firstPubkey) body.error = "no_authorized_keys";
    sendJson(res, 200, body);
  });

  // GET /ssh-keys — full list with fingerprints + bootstrap flag.
  //
  // Returns:
  //   { host, port, user, container, exec_command,
  //     keys: [{ fingerprint, type, comment, bootstrap }, …] }
  //
  // Bootstrap is true for the FIRST usable line in authorized_keys; the
  // UI uses it to refuse "Revoke" on that row (prevent self-lockout).
  addRoute("GET", "/api/v1/system/ssh-keys", async ({ res }) => {
    const host = process.env.DOMAIN || process.env.TENANT_DOMAIN || "localhost";
    const parsed = parseAuthorizedKeys(readAuthorized());
    const keys = parsed.map((k) => ({
      fingerprint: k.fingerprint,
      type: k.type,
      comment: k.comment,
      bootstrap: k.bootstrap,
    }));
    sendJson(res, 200, {
      host,
      port: 22,
      user: "root",
      container: HERMES_CONTAINER,
      exec_command: HERMES_EXEC_CMD,
      keys,
    });
  });

  // POST /ssh-keys — append a pubkey (or generate one).
  //
  // Body shapes:
  //   { pubkey: "ssh-ed25519 AAAA… comment" }
  //   { generate: true, comment?: "laptop" }
  //
  // Returns 201 { ok, fingerprint, type, comment, private_key? } —
  // private_key is ONLY present on generate, and the server never
  // persists it.
  //
  // Errors:
  //   400 — malformed/missing input
  //   409 — same blob (fingerprint match) already in authorized_keys
  addRoute("POST", "/api/v1/system/ssh-keys", async ({ res, body }) => {
    const b = (body ?? {}) as {
      pubkey?: unknown;
      generate?: unknown;
      comment?: unknown;
    };
    const wantGenerate = b.generate === true;
    let added: ParsedKey;
    let privateKey: string | null = null;

    if (wantGenerate) {
      const comment = typeof b.comment === "string" ? b.comment : "";
      const gen = generateEd25519(comment);
      const parsed = parseLine(gen.pubkey, true);
      if (!parsed) throw new ExecError("generated pubkey did not parse");
      added = parsed;
      privateKey = gen.privateKey;
    } else if (typeof b.pubkey === "string") {
      const parsed = parseLine(b.pubkey, true);
      if (!parsed) {
        throw new ValidationError(
          "pubkey must be an OpenSSH-format line: <type> <base64-blob> [comment]. " +
            "Authorized-keys options (command=, from=, …) are not accepted.",
        );
      }
      added = parsed;
    } else {
      throw new ValidationError(
        "either 'pubkey' (string) or 'generate' (true) is required",
      );
    }

    // Idempotency: same blob already installed → 409 (the existing entry
    // wins; the user can revoke + re-add if they need a different comment).
    const existing = parseAuthorizedKeys(readAuthorized());
    if (existing.some((k) => k.blob === added.blob)) {
      throw new ConflictError(`key already installed (${added.fingerprint})`);
    }

    const raw = readAuthorized();
    const sep = raw.length === 0 || raw.endsWith("\n") ? "" : "\n";
    writeAuthorizedKeys(`${raw}${sep}${added.raw}\n`);

    const payload: Record<string, unknown> = {
      ok: true,
      fingerprint: added.fingerprint,
      type: added.type,
      comment: added.comment,
    };
    if (privateKey) payload.private_key = privateKey;
    sendJson(res, 201, payload);
  });

  // POST /ssh-keys/revoke — drop a non-bootstrap key by fingerprint.
  //
  // POST (not DELETE-with-path) because SHA256 fingerprints contain `/`
  // and `+`, which need URL-encoding in a path param and trip the
  // [^/]+ matcher in our router. Body-carried fingerprint avoids that.
  //
  // Refuses to revoke the bootstrap (first) key — sole guard against
  // accidentally locking yourself out from the UI.
  addRoute("POST", "/api/v1/system/ssh-keys/revoke", async ({ res, body }) => {
    const b = (body ?? {}) as { fingerprint?: unknown };
    if (typeof b.fingerprint !== "string" || !b.fingerprint.trim()) {
      throw new ValidationError("fingerprint (string) is required");
    }
    const target = b.fingerprint.trim();
    const raw = readAuthorized();
    const parsed = parseAuthorizedKeys(raw);
    const hit = parsed.find((k) => k.fingerprint === target);
    if (!hit) throw new NotFoundError(`no key with fingerprint ${target}`);
    if (hit.bootstrap) {
      throw new ConflictError(
        "refusing to revoke the bootstrap key (first line of authorized_keys); " +
          "add another key first, then revoke this one over SSH directly",
      );
    }

    // Rewrite the file, dropping only the matched line. Preserve comments
    // and blank lines — the operator might have organised the file with
    // section headers.
    const out = raw
      .split(/\r?\n/)
      .filter((line) => {
        const k = parseLine(line);
        return !k || k.fingerprint !== target;
      })
      .join("\n");
    const normalised = out.endsWith("\n") || out === "" ? out : out + "\n";
    writeAuthorizedKeys(normalised);

    sendJson(res, 200, { ok: true, revoked: target });
  });
}
