import {
  Activity,
  ArrowLeft,
  CheckCircle,
  Clock,
  Globe,
  Play,
  RefreshCw,
  RotateCcw,
  Server,
  Smartphone,
  Square,
  TerminalSquare,
  Trash2,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { Button } from "../../../client/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../client/components/ui/dialog";
import { Input } from "../../../client/components/ui/input";
import { useParams } from "react-router-dom";
import GodmodeTerminal from "../../components/GodmodeTerminal";
import {
  useQuery,
  useAction,
  getAdminInstanceDetail,
  getAdminInstanceHealth,
  getAdminInstanceDevices,
  adminDestroyInstance,
  adminProvisionInstance,
  adminTriggerWorker,
  adminApproveDevice,
  adminRejectDevice,
} from "wasp/client/operations";
import { useAuth } from "wasp/client/auth";
import { Navigate } from "react-router-dom";
import { Link } from "wasp/client/router";
import DashboardLayout from "../../../dashboard/DashboardLayout";

const statusColors: Record<string, string> = {
  running: "bg-green-900 text-green-200",
  provisioning: "bg-yellow-900 text-yellow-200",
  error: "bg-red-900 text-red-200",
  suspended: "bg-orange-900 text-orange-200",
  destroying: "bg-red-900 text-red-200",
  destroyed: "bg-gray-800 text-gray-400",
};

export default function InstanceDetailPage() {
  const { data: user } = useAuth();
  const { instanceId } = useParams<{ instanceId: string }>();
  const [activeTab, setActiveTab] = useState<"overview" | "health" | "devices" | "terminal">("overview");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [destroyOpen, setDestroyOpen] = useState(false);
  const [destroyConfirmText, setDestroyConfirmText] = useState("");

  const { data: instance, isLoading, error, refetch: refetchDetail } = useQuery(
    getAdminInstanceDetail,
    { instanceId: instanceId! },
    { enabled: !!instanceId },
  );

  const { data: healthData, refetch: refetchHealth } = useQuery(
    getAdminInstanceHealth,
    { instanceId: instanceId! },
    { enabled: !!instanceId && activeTab === "health" },
  );

  const { data: devicesData, refetch: refetchDevices } = useQuery(
    getAdminInstanceDevices,
    { instanceId: instanceId! },
    { enabled: !!instanceId && activeTab === "devices" },
  );

  const destroyAction = useAction(adminDestroyInstance);
  const provisionAction = useAction(adminProvisionInstance);
  const triggerAction = useAction(adminTriggerWorker);
  const approveAction = useAction(adminApproveDevice);
  const rejectAction = useAction(adminRejectDevice);

  if (!user) return null;
  if (!user.isAdmin) return <Navigate to="/" replace />;

  const tenantDown =
    instance?.lastHealthStatus === "down" ||
    instance?.lastHealthStatus === "unreachable";

  async function handleAction(name: string, fn: () => Promise<any>) {
    if (!confirm(`Are you sure you want to ${name}?`)) return;
    setActionLoading(name);
    setActionError(null);
    try {
      const result = await fn();
      if (result?.message) alert(result.message);
      refetchDetail();
    } catch (err: any) {
      const msg: string = err.message || "An unexpected error occurred";
      const isConnectivity =
        msg.includes("Failed to reach tenant") ||
        msg.includes("timed out") ||
        msg.includes("Internal tenant error");
      setActionError(
        isConnectivity
          ? "Cannot reach the tenant — the service may be down. Use Godmode SSH to recover manually."
          : `Failed to ${name}: ${msg}`,
      );
    } finally {
      setActionLoading(null);
    }
  }

  const tabs = [
    { id: "overview" as const, label: "Overview", icon: Server },
    { id: "health" as const, label: "Health & Containers", icon: Activity },
    { id: "devices" as const, label: "Devices", icon: Smartphone },
    { id: "terminal" as const, label: "Godmode SSH", icon: TerminalSquare },
  ];

  return (
    <DashboardLayout>
      <div className="p-6 paper">
        {/* M7 #869 — admin tokens pass on the header. */}
        <div className="mb-6 flex items-baseline gap-4">
          <Link
            to="/admin/instances"
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--brass)" }}
          >
            ← Instances
          </Link>
          <div className="flex-1">
            <h1 className="font-display text-4xl tracking-tight">
              {isLoading ? "…" : instance?.customerName || "Instance"}
            </h1>
            {instance && (
              <p
                className="font-body italic mt-1"
                style={{ color: "var(--marginalia)" }}
              >
                {instance.user?.email} · {instance.tier?.toLowerCase()} · {instance.serverType}
              </p>
            )}
          </div>
          {instance && (
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusColors[instance.status] || "bg-gray-800 text-gray-200"}`}>
              {instance.status}
            </span>
          )}
        </div>

        {error && (
          <div className="bg-destructive/10 text-destructive mb-6 rounded-lg p-4">
            {error.message}
          </div>
        )}

        {instance && (
          <>
            {/* Tenant unreachable warning */}
            {(instance.lastHealthStatus === "down" || instance.lastHealthStatus === "unreachable") && (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-800 bg-amber-950/20 p-3 text-sm text-amber-300">
                <XCircle className="size-4 shrink-0" />
                Tenant is <span className="font-mono font-medium">{instance.lastHealthStatus}</span> — service actions are disabled. Use the Godmode SSH terminal to recover.
              </div>
            )}

            {/* Action error banner */}
            {actionError && (
              <div className="mb-4 flex items-start gap-3 rounded-lg border border-red-800 bg-red-950/30 p-3 text-sm text-red-300">
                <XCircle className="mt-0.5 size-4 shrink-0" />
                <span className="flex-1">{actionError}</span>
                <button
                  onClick={() => setActionError(null)}
                  className="shrink-0 text-red-400 hover:text-red-200"
                  aria-label="Dismiss"
                >
                  ✕
                </button>
              </div>
            )}

            {/* Action bar */}
            <div className="mb-6 flex flex-wrap gap-2">
              {(instance.status === "error" || instance.status === "provisioning" || instance.status === "destroyed") && (
                <ActionButton
                  icon={RefreshCw}
                  label="Re-provision"
                  loading={actionLoading === "re-provision"}
                  onClick={() => handleAction("re-provision", () => provisionAction({ instanceId: instance.id }))}
                />
              )}
              {instance.status === "running" && (
                <>
                  <ActionButton
                    icon={RotateCcw}
                    label="Restart Alfred"
                    loading={actionLoading === "restart-alfred"}
                    disabled={tenantDown}
                    onClick={() => handleAction("restart-alfred", () => triggerAction({ instanceId: instance.id, action: "restart", service: "alfred" }))}
                  />
                  <ActionButton
                    icon={Square}
                    label="Stop Alfred"
                    loading={actionLoading === "stop-alfred"}
                    disabled={tenantDown}
                    onClick={() => handleAction("stop-alfred", () => triggerAction({ instanceId: instance.id, action: "stop", service: "alfred" }))}
                  />
                  <ActionButton
                    icon={Play}
                    label="Start Alfred"
                    loading={actionLoading === "start-alfred"}
                    disabled={tenantDown}
                    onClick={() => handleAction("start-alfred", () => triggerAction({ instanceId: instance.id, action: "start", service: "alfred" }))}
                  />
                  <ActionButton
                    icon={RotateCcw}
                    label="Restart Temporal"
                    loading={actionLoading === "restart-temporal"}
                    disabled={tenantDown}
                    onClick={() => handleAction("restart-temporal", () => triggerAction({ instanceId: instance.id, action: "restart", service: "temporal" }))}
                  />
                </>
              )}
              {instance.status !== "destroyed" && (
                <ActionButton
                  icon={Trash2}
                  label="Destroy"
                  variant="destructive"
                  loading={actionLoading === "destroy"}
                  onClick={() => {
                    setDestroyConfirmText("");
                    setDestroyOpen(true);
                  }}
                />
              )}
            </div>

            {/* External links */}
            {instance.status === "running" && (instance.subdomainUrl || instance.tailscaleHostname) && (
              <div className="mb-6 flex flex-wrap gap-3">
                {instance.subdomainUrl && (
                  <ExternalLink
                    icon={Globe}
                    label="Control UI"
                    href={instance.gatewayToken
                      ? `${instance.subdomainUrl}/?token=${instance.gatewayToken}`
                      : instance.subdomainUrl}
                  />
                )}
                {instance.tailscaleHostname && (
                  <ExternalLink
                    icon={Clock}
                    label="Temporal UI"
                    href={`https://${instance.tailscaleHostname}:8233`}
                  />
                )}
              </div>
            )}

            {/* Tabs */}
            <div className="border-border mb-6 flex gap-1 border-b">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
                    activeTab === tab.id
                      ? "border-primary text-primary"
                      : "text-muted-foreground hover:text-foreground border-transparent"
                  }`}
                >
                  <tab.icon className="size-4" />
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Tab content */}
            {activeTab === "overview" && <OverviewTab instance={instance} />}
            {activeTab === "health" && (
              <HealthTab data={healthData} onRefresh={refetchHealth} instanceId={instance.id} />
            )}
            {activeTab === "devices" && (
              <DevicesTab
                data={devicesData}
                instanceId={instance.id}
                onApprove={(requestId: string) =>
                  handleAction("approve device", () => approveAction({ instanceId: instance.id, requestId }))
                }
                onReject={(requestId: string) =>
                  handleAction("reject device", () => rejectAction({ instanceId: instance.id, requestId }))
                }
                onRefresh={refetchDevices}
              />
            )}
            {activeTab === "terminal" && (
              instance.status === "running" ? (
                <GodmodeTerminal instanceId={instance.id} instanceName={instance.customerName} />
              ) : (
                <div className="rounded border border-amber-900/30 bg-amber-950/10 p-6 text-center">
                  <p className="font-mono text-sm text-amber-400">Instance must be running to use Godmode SSH.</p>
                  <p className="mt-1 text-xs text-muted-foreground">Current status: {instance.status}</p>
                </div>
              )
            )}

            {/* Destroy Confirmation Dialog */}
            <Dialog open={destroyOpen} onOpenChange={(v) => {
              setDestroyOpen(v);
              if (!v) setDestroyConfirmText("");
            }}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Destroy Instance</DialogTitle>
                  <DialogDescription>
                    This will permanently destroy the Hetzner server, volumes, and all data
                    for <span className="font-mono font-bold">{instance.customerName}</span>.
                    This cannot be undone.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <p className="text-sm">
                    Type{" "}
                    <span className="font-mono font-bold">{instance.customerName}</span>{" "}
                    to confirm:
                  </p>
                  <Input
                    value={destroyConfirmText}
                    onChange={(e) => setDestroyConfirmText(e.target.value)}
                    placeholder={instance.customerName}
                  />
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setDestroyOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={destroyConfirmText !== instance.customerName || actionLoading === "destroy"}
                    onClick={async () => {
                      setActionLoading("destroy");
                      try {
                        const result = await destroyAction({ instanceId: instance.id });
                        if (result?.message) alert(result.message);
                        setDestroyOpen(false);
                        refetchDetail();
                      } catch (err: any) {
                        alert(`Error: ${err.message}`);
                      } finally {
                        setActionLoading(null);
                      }
                    }}
                  >
                    {actionLoading === "destroy" ? "Destroying..." : "Destroy Instance"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

function ActionButton({
  icon: Icon,
  label,
  onClick,
  loading,
  disabled,
  variant,
}: {
  icon: any;
  label: string;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: "destructive";
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading || disabled}
      title={disabled && !loading ? "Tenant is unreachable" : undefined}
      className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
        variant === "destructive"
          ? "bg-red-900/50 text-red-300 hover:bg-red-900"
          : "bg-accent text-accent-foreground hover:bg-accent/80"
      } disabled:cursor-not-allowed disabled:opacity-50`}
    >
      <Icon className={`size-4 ${loading ? "animate-spin" : ""}`} />
      {label}
    </button>
  );
}

function ExternalLink({ icon: Icon, label, href }: { icon: any; label: string; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-muted-foreground hover:text-foreground flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm transition-colors"
    >
      <Icon className="size-4" />
      {label}
    </a>
  );
}

function OverviewTab({ instance }: { instance: any }) {
  const fields = [
    { label: "ID", value: instance.id },
    { label: "Customer Name", value: instance.customerName },
    { label: "Owner", value: instance.user?.email || "-" },
    { label: "Tier", value: instance.tier },
    { label: "Server Type", value: instance.serverType },
    { label: "Status", value: instance.status },
    { label: "IP Address", value: instance.ipAddress || "-" },
    { label: "Tailscale Hostname", value: instance.tailscaleHostname || "-" },
    { label: "Last Health Check", value: instance.lastHealthCheck ? new Date(instance.lastHealthCheck).toLocaleString() : "-" },
    { label: "Last Health Status", value: instance.lastHealthStatus || "-" },
    { label: "Provisioned At", value: instance.provisionedAt ? new Date(instance.provisionedAt).toLocaleString() : "-" },
    { label: "Suspended At", value: instance.suspendedAt ? new Date(instance.suspendedAt).toLocaleString() : "-" },
    { label: "Created At", value: new Date(instance.createdAt).toLocaleString() },
    { label: "Updated At", value: new Date(instance.updatedAt).toLocaleString() },
  ];

  return (
    <div className="space-y-6">
      {/* Instance details */}
      <div className="rounded-lg border border-border">
        <div className="border-border border-b px-4 py-3">
          <h3 className="text-foreground text-sm font-semibold">Instance Details</h3>
        </div>
        <div className="divide-border divide-y">
          {fields.map((field) => (
            <div key={field.label} className="flex items-center px-4 py-3">
              <span className="text-muted-foreground w-48 shrink-0 text-sm">{field.label}</span>
              <span className="text-foreground text-sm font-mono">{field.value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Provisioning job */}
      {instance.provisioningJob && (
        <div className="rounded-lg border border-border">
          <div className="border-border border-b px-4 py-3">
            <h3 className="text-foreground text-sm font-semibold">Latest Provisioning Job</h3>
          </div>
          <div className="divide-border divide-y">
            <div className="flex items-center px-4 py-3">
              <span className="text-muted-foreground w-48 shrink-0 text-sm">Status</span>
              <span className={`text-sm font-medium ${
                instance.provisioningJob.status === "completed" ? "text-green-400"
                  : instance.provisioningJob.status === "failed" ? "text-red-400"
                  : instance.provisioningJob.status === "running" ? "text-yellow-400"
                  : "text-muted-foreground"
              }`}>
                {instance.provisioningJob.status}
              </span>
            </div>
            {instance.provisioningJob.currentStep && (
              <div className="flex items-center px-4 py-3">
                <span className="text-muted-foreground w-48 shrink-0 text-sm">Current Step</span>
                <span className="text-foreground text-sm font-mono">{instance.provisioningJob.currentStep}</span>
              </div>
            )}
            {instance.provisioningJob.error && (
              <div className="flex items-start px-4 py-3">
                <span className="text-muted-foreground w-48 shrink-0 text-sm">Error</span>
                <span className="text-red-400 text-sm font-mono">{instance.provisioningJob.error}</span>
              </div>
            )}
            <div className="flex items-center px-4 py-3">
              <span className="text-muted-foreground w-48 shrink-0 text-sm">Created</span>
              <span className="text-foreground text-sm font-mono">{new Date(instance.provisioningJob.createdAt).toLocaleString()}</span>
            </div>
            {instance.provisioningJob.logs?.length > 0 && (
              <div className="px-4 py-3">
                <span className="text-muted-foreground mb-2 block text-sm">Logs</span>
                <pre className="bg-background max-h-64 overflow-auto rounded p-3 text-xs font-mono text-muted-foreground">
                  {instance.provisioningJob.logs.join("\n")}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}

      {/* User subscription info */}
      <div className="rounded-lg border border-border">
        <div className="border-border border-b px-4 py-3">
          <h3 className="text-foreground text-sm font-semibold">User & Subscription</h3>
        </div>
        <div className="divide-border divide-y">
          <div className="flex items-center px-4 py-3">
            <span className="text-muted-foreground w-48 shrink-0 text-sm">Email</span>
            <span className="text-foreground text-sm font-mono">{instance.user?.email || "-"}</span>
          </div>
          <div className="flex items-center px-4 py-3">
            <span className="text-muted-foreground w-48 shrink-0 text-sm">Subscription Status</span>
            <span className="text-foreground text-sm font-mono">{instance.user?.subscriptionStatus || "-"}</span>
          </div>
          <div className="flex items-center px-4 py-3">
            <span className="text-muted-foreground w-48 shrink-0 text-sm">Plan</span>
            <span className="text-foreground text-sm font-mono">{instance.user?.subscriptionPlan || "-"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function HealthTab({
  data,
  onRefresh,
  instanceId,
}: {
  data: any;
  onRefresh: () => void;
  instanceId: string;
}) {
  if (!data) {
    return <p className="text-muted-foreground">Loading health data...</p>;
  }

  if (data.error) {
    return (
      <div className="space-y-4">
        <div className="bg-destructive/10 text-destructive rounded-lg p-4">
          Could not reach instance: {data.error}
        </div>
        <button onClick={onRefresh} className="bg-accent text-accent-foreground rounded-md px-3 py-2 text-sm">
          Retry
        </button>
      </div>
    );
  }

  if (!data.containers && !data.health) {
    return (
      <div className="space-y-4">
        <p className="text-muted-foreground">Instance is not running or not reachable.</p>
        <p className="text-muted-foreground text-sm">Status: {data.status}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-foreground text-sm font-semibold">Container Status</h3>
        <button onClick={onRefresh} className="text-muted-foreground hover:text-foreground text-sm flex items-center gap-1">
          <RefreshCw className="size-3" /> Refresh
        </button>
      </div>

      {/* Containers */}
      {data.containers && Array.isArray(data.containers) ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-border border-b bg-muted/50">
                <th className="text-muted-foreground p-3 text-left font-medium">Service</th>
                <th className="text-muted-foreground p-3 text-left font-medium">State</th>
                <th className="text-muted-foreground p-3 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.containers.map((c: any, i: number) => (
                <tr key={i} className="border-border border-b">
                  <td className="text-foreground p-3 font-mono font-medium">{c.Service || c.Name || c.name}</td>
                  <td className="p-3">
                    <span className={`inline-block rounded-full px-2 py-1 text-xs font-medium ${
                      c.State === "running" ? "bg-green-900 text-green-200"
                        : c.State === "exited" && c.ExitCode === 0 ? "bg-gray-800 text-gray-300"
                        : "bg-red-900 text-red-200"
                    }`}>
                      {c.State}
                    </span>
                  </td>
                  <td className="text-muted-foreground p-3 font-mono text-xs">{c.Status || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : data.containers ? (
        <pre className="bg-muted rounded-lg p-4 text-xs font-mono text-muted-foreground overflow-auto">
          {JSON.stringify(data.containers, null, 2)}
        </pre>
      ) : null}

      {/* Health summary */}
      {data.health && (
        <div className="rounded-lg border border-border">
          <div className="border-border border-b px-4 py-3">
            <h3 className="text-foreground text-sm font-semibold">Health Summary</h3>
          </div>
          <pre className="p-4 text-xs font-mono text-muted-foreground overflow-auto max-h-64">
            {JSON.stringify(data.health, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function DevicesTab({
  data,
  instanceId,
  onApprove,
  onReject,
  onRefresh,
}: {
  data: any;
  instanceId: string;
  onApprove: (requestId: string) => void;
  onReject: (requestId: string) => void;
  onRefresh: () => void;
}) {
  if (!data) {
    return <p className="text-muted-foreground">Loading devices...</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-foreground text-sm font-semibold">Devices</h3>
        <button onClick={onRefresh} className="text-muted-foreground hover:text-foreground text-sm flex items-center gap-1">
          <RefreshCw className="size-3" /> Refresh
        </button>
      </div>

      {/* Pending devices */}
      {data.pending?.length > 0 && (
        <div className="rounded-lg border border-yellow-800">
          <div className="border-yellow-800 border-b bg-yellow-900/20 px-4 py-3">
            <h4 className="text-yellow-300 text-sm font-semibold">Pending Approval ({data.pending.length})</h4>
          </div>
          <div className="divide-border divide-y">
            {data.pending.map((device: any) => (
              <div key={device.requestId || device.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-foreground text-sm font-medium">{device.name || device.requestId}</p>
                  <p className="text-muted-foreground text-xs">{device.type || "unknown"}</p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => onApprove(device.requestId || device.id)}
                    className="flex items-center gap-1 rounded bg-green-900/50 px-3 py-1 text-xs text-green-300 hover:bg-green-900"
                  >
                    <CheckCircle className="size-3" /> Approve
                  </button>
                  <button
                    onClick={() => onReject(device.requestId || device.id)}
                    className="flex items-center gap-1 rounded bg-red-900/50 px-3 py-1 text-xs text-red-300 hover:bg-red-900"
                  >
                    <XCircle className="size-3" /> Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Paired devices */}
      {data.paired?.length > 0 ? (
        <div className="rounded-lg border border-border">
          <div className="border-border border-b px-4 py-3">
            <h4 className="text-foreground text-sm font-semibold">Paired Devices ({data.paired.length})</h4>
          </div>
          <div className="divide-border divide-y">
            {data.paired.map((device: any, i: number) => (
              <div key={device.id || i} className="flex items-center px-4 py-3">
                <Smartphone className="text-muted-foreground mr-3 size-4" />
                <div>
                  <p className="text-foreground text-sm font-medium">{device.name || device.id}</p>
                  <p className="text-muted-foreground text-xs">
                    {device.type || "device"} &middot; paired {device.pairedAt ? new Date(device.pairedAt).toLocaleDateString() : ""}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        !data.pending?.length && (
          <p className="text-muted-foreground text-sm">No devices connected to this instance.</p>
        )
      )}
    </div>
  );
}
