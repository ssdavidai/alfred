// terminalCardCore — pure shape derivation for the /channels Terminal
// card. Import-free (no React/Wasp) so it unit-tests under node:test
// alongside hermesHealthCore / apiKeysCore.
//
// The card now uses /api/v1/system/ssh-keys (rich list — used by the
// self-contained card UX) as its primary source. /ssh-info stays for
// back-compat (legacy SshInfo shape).

export interface SshInfo {
  hostname: string | null;
  port: number | null;
  user: string | null;
  pubkey: string | null;
  hermes_exec: string | null;
}

export interface InstalledSshKey {
  fingerprint: string;
  type: string;
  comment: string;
  bootstrap: boolean;
}

export interface SshKeys {
  host: string;
  port: number;
  user: string;
  container: string;
  exec_command: string;
  keys: InstalledSshKey[];
}

// Fallback when ctrl-api hasn't backfilled hermes_exec yet — the Hermes
// container name is well-known across tenants.
export const DEFAULT_HERMES_EXEC =
  "docker exec -it alfred-black-hermes-1 hermes";

export interface TerminalCardState {
  ready: boolean;
  sshTarget: string;
  hermesExec: string;
}

export function deriveTerminalCardState(ssh: SshInfo): TerminalCardState {
  const ready = Boolean(ssh.pubkey && ssh.hostname);
  const sshTarget =
    ssh.hostname && ssh.user
      ? `${ssh.user}@${ssh.hostname}${ssh.port && ssh.port !== 22 ? ` -p ${ssh.port}` : ""}`
      : ssh.hostname || "";
  const hermesExec = ssh.hermes_exec || DEFAULT_HERMES_EXEC;
  return { ready, sshTarget, hermesExec };
}

// Self-contained card derivation (Sir 2026-05-26): SshKeys → the strings
// the card actually renders. `status` follows the cross-card convention:
//   * active     — at least one key on file (we can SSH in)
//   * available  — file is parsable but empty (fresh VM, no bootstrap)
export interface TerminalCardStateV2 {
  status: "active" | "available";
  sshTarget: string;
  hermesExec: string;
  sshCommand: string;
  /** Canonical `ssh-keygen` line the card surfaces under "First time?". */
  sshKeygenCommand: string;
  hasBootstrap: boolean;
  installedCount: number;
}

export function deriveTerminalCardStateV2(data: SshKeys): TerminalCardStateV2 {
  const sshTarget =
    data.user && data.host
      ? `${data.user}@${data.host}${data.port && data.port !== 22 ? ` -p ${data.port}` : ""}`
      : data.host || "";
  const sshCommand = sshTarget ? `ssh ${sshTarget}` : "";
  const hermesExec = data.exec_command || DEFAULT_HERMES_EXEC;
  // Comment ties the key on the user's disk back to the tenant.
  const comment = data.host ? `alfred-${data.host}` : "alfred";
  const sshKeygenCommand = `ssh-keygen -t ed25519 -C '${comment}'`;
  const hasBootstrap = data.keys.some((k) => k.bootstrap);
  const installedCount = data.keys.length;
  return {
    status: installedCount > 0 ? "active" : "available",
    sshTarget,
    hermesExec,
    sshCommand,
    sshKeygenCommand,
    hasBootstrap,
    installedCount,
  };
}

/** A line for the keys list. Bootstrap rows render with a 🔒 + no
 *  Revoke button; everything else gets a Revoke link. */
export interface KeyRowDisplay {
  fingerprint: string;
  type: string;
  comment: string;
  bootstrap: boolean;
  /** Tooltip / aria-label text — explains why bootstrap is locked. */
  lockReason?: string;
}

export function toKeyRows(keys: InstalledSshKey[]): KeyRowDisplay[] {
  return keys.map((k) => ({
    fingerprint: k.fingerprint,
    type: k.type,
    comment: k.comment || "(no comment)",
    bootstrap: k.bootstrap,
    lockReason: k.bootstrap
      ? "Bootstrap key — installed when the VM was provisioned. Revoke it over SSH directly if you really mean to."
      : undefined,
  }));
}

/** Strict client-side validation for a pasted pubkey. Mirrors the
 *  server's PUBKEY_INPUT_RE so we 400 early without a round-trip. */
export function isProbablyValidPubkey(s: string): boolean {
  return /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com)\s+[A-Za-z0-9+/=]{20,}(?:\s+\S.*)?$/.test(
    s.trim(),
  );
}
