// terminalCardCore — pure shape derivation for the /channels Terminal
// card (Sir #8). Import-free (no React/Wasp) so it unit-tests under
// node:test the same way hermesHealthCore / apiKeysCore do.

export interface SshInfo {
  hostname: string | null;
  port: number | null;
  user: string | null;
  pubkey: string | null;
  hermes_exec: string | null;
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
