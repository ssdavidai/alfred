/**
 * ComposioConnection repository helpers.
 *
 * Wraps the Prisma delegate so operations.ts stays declarative. Every helper
 * takes the Prisma delegate (`context.entities.ComposioConnection`) so the
 * caller stays in control of which entities it registers with Wasp.
 *
 * The repo is the SaaS-side source of truth for a connection's auto-config
 * lifecycle (pending → running → configured | error). The tenant side owns
 * the actual side-effects (streams.json, openclaw.json, workspace/skills).
 */

// Wasp generates typed Prisma delegates; we accept a loosely-typed delegate
// here so this helper stays independent of Wasp's generated types.
type Delegate = {
  findUnique: (args: any) => Promise<any>;
  findMany: (args: any) => Promise<any[]>;
  create: (args: any) => Promise<any>;
  update: (args: any) => Promise<any>;
  upsert: (args: any) => Promise<any>;
  deleteMany: (args: any) => Promise<any>;
};

export interface ComposioConnectionRow {
  id: string;
  userId: string;
  connectionId: string;
  toolkit: string;
  label: string | null;
  iconUrl: string | null;
  authScheme: string | null;
  status: string;
  autoConfigState: "pending" | "running" | "configured" | "error";
  autoConfigError: string | null;
  autoConfiguredAt: Date | null;
  streamsCreated: number;
  toolsEnabled: number;
  skillName: string | null;
  lastSyncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Called from initiateConnect, finalizeComposioConnections, and lazy
 * backfill in getConnectedIntegrations. Keyed on (userId, toolkit) which
 * is unique — same user connecting the same toolkit twice replaces the
 * prior row (matches Composio's behavior — one connected_account per
 * user/toolkit pair).
 */
export async function upsertConnection(
  delegate: Delegate,
  params: {
    userId: string;
    connectionId: string;
    toolkit: string;
    label?: string | null;
    iconUrl?: string | null;
    authScheme?: string | null;
    status?: string;
  },
): Promise<ComposioConnectionRow> {
  const toolkit = params.toolkit.toLowerCase();
  return delegate.upsert({
    where: { userId_toolkit: { userId: params.userId, toolkit } },
    create: {
      userId: params.userId,
      connectionId: params.connectionId,
      toolkit,
      label: params.label ?? null,
      iconUrl: params.iconUrl ?? null,
      authScheme: params.authScheme ?? null,
      status: params.status ?? "INITIATED",
      autoConfigState: "pending",
    },
    update: {
      connectionId: params.connectionId,
      label: params.label ?? undefined,
      iconUrl: params.iconUrl ?? undefined,
      authScheme: params.authScheme ?? undefined,
      status: params.status ?? undefined,
      lastSyncedAt: new Date(),
    },
  });
}

export async function markAutoConfigRunning(
  delegate: Delegate,
  userId: string,
  connectionId: string,
): Promise<void> {
  const existing = await delegate.findUnique({
    where: { connectionId },
  });
  if (!existing || existing.userId !== userId) return;
  await delegate.update({
    where: { connectionId },
    data: { autoConfigState: "running", autoConfigError: null },
  });
}

/**
 * Flip a row's `status` from whatever it was (typically `INITIATED`) to
 * `ACTIVE`. Used by the reconciler when Composio's API confirms the
 * connection is live but the inbound webhook never flipped our row.
 *
 * Intentionally narrow: this only writes `status` + `lastSyncedAt`, never
 * touches `autoConfigState`. The reconciler still drives the auto-config
 * lifecycle (running → configured | error) through the existing helpers.
 */
export async function markStatusActive(
  delegate: Delegate,
  userId: string,
  connectionId: string,
): Promise<void> {
  const existing = await delegate.findUnique({
    where: { connectionId },
  });
  if (!existing || existing.userId !== userId) return;
  if (existing.status === "ACTIVE") return; // already there — no-op
  await delegate.update({
    where: { connectionId },
    data: {
      status: "ACTIVE",
      lastSyncedAt: new Date(),
    },
  });
}

/**
 * Apply the auto-config result returned by the tenant's ctrl-api to the
 * SaaS row. Result shape is whatever integrations.ts:/auto-config returned
 * — see the inline `summary` object there.
 */
export async function applyAutoConfigResult(
  delegate: Delegate,
  userId: string,
  connectionId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const existing = await delegate.findUnique({
    where: { connectionId },
  });
  if (!existing || existing.userId !== userId) return;

  const streamsCreated = result.stream_created ? 1 : 0;
  const toolsEnabled = typeof result.actions_count === "number" ? (result.actions_count as number) : 0;
  const skillName = extractSkillName(result.skill_generated);

  await delegate.update({
    where: { connectionId },
    data: {
      autoConfigState: "configured",
      autoConfigError: null,
      autoConfiguredAt: new Date(),
      streamsCreated,
      toolsEnabled,
      skillName,
      status: "ACTIVE",
      lastSyncedAt: new Date(),
    },
  });
}

export async function markAutoConfigError(
  delegate: Delegate,
  userId: string,
  connectionId: string,
  error: string,
): Promise<void> {
  const existing = await delegate.findUnique({
    where: { connectionId },
  });
  if (!existing || existing.userId !== userId) return;
  await delegate.update({
    where: { connectionId },
    data: {
      autoConfigState: "error",
      autoConfigError: error.slice(0, 500),
      lastSyncedAt: new Date(),
    },
  });
}

export async function deleteConnection(
  delegate: Delegate,
  userId: string,
  connectionId: string,
): Promise<void> {
  await delegate.deleteMany({
    where: { userId, connectionId },
  });
}

export async function listConnectionsForUser(
  delegate: Delegate,
  userId: string,
): Promise<ComposioConnectionRow[]> {
  return delegate.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Tenant sometimes returns a path like
 * "/home/node/.openclaw/workspace/skills/alfred-composio-gmail".
 * We want just the skill slug ("alfred-composio-gmail").
 */
function extractSkillName(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  const parts = raw.replace(/\/$/, "").split("/");
  const last = parts[parts.length - 1];
  return last || null;
}
