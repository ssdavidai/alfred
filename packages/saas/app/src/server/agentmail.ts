// AgentMail per-tenant inbox provisioning.
//
// One-time SaaS bootstrap (domain + shared pod + webhook) happens via
// deploy/agentmail-bootstrap.sh. This module owns the per-tenant leg:
// create an inbox in the shared pod, mint an inbox-scoped API key, and
// hand back the credentials for the caller to persist on Instance and
// push to the tenant VM.
//
// Feature-flagged via AGENTMAIL_ENABLED. When off, provisionAgentMailForTenant
// is a no-op returning null so existing signup flows are untouched.

import { encryptApiKey } from "./tenantProxy";

const AGENTMAIL_API = "https://api.agentmail.to/v0";

export interface ProvisionAgentMailResult {
  inboxId: string;
  inboxAddress: string;
  inboxApiKeyEncrypted: string;
}

export function isAgentMailEnabled(): boolean {
  return (
    process.env.AGENTMAIL_ENABLED === "true" &&
    !!process.env.AGENTMAIL_MASTER_API_KEY &&
    !!process.env.AGENTMAIL_SHARED_POD_ID
  );
}

// Primary username: email local part, normalized.
// `david@szabostuban.com`       -> `alfred.david`
// `daveszab@gmail.com`          -> `alfred.daveszab`
// `david.szabostuban@gmail.com` -> `alfred.david.szabostuban`
export function buildInboxUsername(email: string | null | undefined): string {
  const local = (email ?? "user")
    .split("@")[0]
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\.|\.$/g, "");
  return `alfred.${local || "user"}`;
}

// Fallback on duplicate username collision: first segment + 3-digit random.
export function buildFallbackUsername(email: string | null | undefined): string {
  const firstSegment =
    (email ?? "user")
      .split("@")[0]
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 20) || "user";
  const suffix = 100 + Math.floor(Math.random() * 900);
  return `alfred.${firstSegment}${suffix}`;
}

async function am(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const key = process.env.AGENTMAIL_MASTER_API_KEY;
  if (!key) {
    throw new Error("AGENTMAIL_MASTER_API_KEY not configured");
  }
  const res = await fetch(`${AGENTMAIL_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function isDuplicateUsernameError(status: number, body: any): boolean {
  if (status !== 400 && status !== 409) return false;
  const serialized = JSON.stringify(body ?? {}).toLowerCase();
  return (
    serialized.includes("already exists") ||
    serialized.includes("duplicate") ||
    serialized.includes("unique") ||
    serialized.includes("taken") ||
    serialized.includes("username")
  );
}

/**
 * Create an inbox for a tenant in the shared pod and mint an inbox-scoped key.
 *
 * Idempotent: relies on the caller to check Instance.agentmailInboxId before
 * calling. If called twice, AgentMail's client_id dedup returns the existing
 * inbox; however the API key from the first call is lost (only returned once),
 * so a fresh key is always minted. That's fine — old keys can be cleaned up
 * by listing and deleting, but we don't force the caller to.
 */
export async function provisionAgentMailForTenant(params: {
  userId: string;
  userEmail: string;
  displayName?: string;
}): Promise<ProvisionAgentMailResult | null> {
  if (!isAgentMailEnabled()) {
    console.info(
      `[agentmail] AGENTMAIL_ENABLED is false, skipping provisioning for user ${params.userId}`,
    );
    return null;
  }

  const podId = process.env.AGENTMAIL_SHARED_POD_ID!;
  const domain = process.env.AGENTMAIL_DOMAIN || "mail.alfred.black";
  const clientId = `tenant-${params.userId}`;

  // 1. Create inbox (with duplicate-username retry)
  let inbox: any = null;
  let username = buildInboxUsername(params.userEmail);

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await am(`/pods/${podId}/inboxes`, {
      method: "POST",
      body: JSON.stringify({
        username,
        domain,
        display_name: params.displayName || `Alfred for ${params.userEmail}`,
        client_id: clientId,
      }),
    });
    if (res.status >= 200 && res.status < 300 && res.body?.inbox_id) {
      inbox = res.body;
      break;
    }
    if (isDuplicateUsernameError(res.status, res.body)) {
      console.warn(
        `[agentmail] username ${username} collided, falling back (attempt ${attempt + 1}/4)`,
      );
      username = buildFallbackUsername(params.userEmail);
      continue;
    }
    throw new Error(
      `AgentMail inbox create failed (status=${res.status}): ${JSON.stringify(res.body)}`,
    );
  }

  if (!inbox) {
    throw new Error(
      `AgentMail inbox create failed after 4 username attempts for user ${params.userId}`,
    );
  }

  // 2. Mint inbox-scoped API key (returned once — store encrypted immediately)
  const keyRes = await am(`/inboxes/${inbox.inbox_id}/api-keys`, {
    method: "POST",
    body: JSON.stringify({
      name: `${clientId}-main-${Date.now()}`,
    }),
  });
  if (
    keyRes.status < 200 ||
    keyRes.status >= 300 ||
    !keyRes.body?.api_key
  ) {
    throw new Error(
      `AgentMail api-key create failed (status=${keyRes.status}): ${JSON.stringify(keyRes.body)}`,
    );
  }

  return {
    inboxId: inbox.inbox_id,
    inboxAddress: inbox.email,
    inboxApiKeyEncrypted: encryptApiKey(keyRes.body.api_key),
  };
}
