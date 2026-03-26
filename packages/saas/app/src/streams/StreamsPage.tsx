import { useState } from "react";
import {
  useQuery,
  getStreams,
  createStream,
  pauseStream,
  resumeStream,
  deleteStream,
  regenerateWebhookToken,
} from "wasp/client/operations";
import DashboardLayout from "../dashboard/DashboardLayout";
import { Button } from "../client/components/ui/button";
import { Input } from "../client/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../client/components/ui/dialog";
import {
  Activity,
  Mail,
  Smartphone,
  ShoppingBag,
  GitBranch,
  Zap,
  Plus,
  Radio,
  Loader2,
  ArrowLeft,
} from "lucide-react";
import StreamCard from "./components/StreamCard";
import EventLog from "./components/EventLog";

interface IntegrationDef {
  value: string;
  label: string;
  description: string;
  type: string;
  icon: React.ComponentType<{ className?: string }>;
}

const INTEGRATIONS: IntegrationDef[] = [
  {
    value: "openclaw",
    label: "OpenClaw Sessions",
    description: "Capture AI gateway sessions and model interactions automatically.",
    type: "scheduled",
    icon: Activity,
  },
  {
    value: "gmail",
    label: "Gmail",
    description: "Monitor your inbox for important emails and actionable messages.",
    type: "scheduled",
    icon: Mail,
  },
  {
    value: "omi",
    label: "Omi Ambient",
    description: "Stream real-time ambient data from your Omi wearable device.",
    type: "realtime",
    icon: Smartphone,
  },
  {
    value: "polar",
    label: "Polar Payments",
    description: "Track payment events, subscriptions, and billing activity.",
    type: "webhook",
    icon: ShoppingBag,
  },
  {
    value: "github",
    label: "GitHub",
    description: "Receive push events, pull requests, and issue updates via webhooks.",
    type: "webhook",
    icon: GitBranch,
  },
  {
    value: "custom",
    label: "Custom",
    description: "Connect any service that can send webhooks to a unique URL.",
    type: "webhook",
    icon: Zap,
  },
];


export default function StreamsPage() {
  const { data: streams, isLoading, error, refetch } = useQuery(getStreams);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [selectedStreamId, setSelectedStreamId] = useState<string | null>(null);
  const [showConnectDialog, setShowConnectDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);

  // Integration connect flow state
  const [connectStep, setConnectStep] = useState<"pick" | "name">("pick");
  const [selectedIntegration, setSelectedIntegration] = useState<IntegrationDef | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const handlePause = async (id: string) => {
    setActionLoading(id);
    try {
      await pauseStream({ id });
      refetch();
    } catch (err: any) {
      console.error("Pause failed:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleResume = async (id: string) => {
    setActionLoading(id);
    try {
      await resumeStream({ id });
      refetch();
    } catch (err: any) {
      console.error("Resume failed:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (id: string) => {
    setActionLoading(id);
    try {
      await deleteStream({ id });
      setShowDeleteConfirm(null);
      if (selectedStreamId === id) setSelectedStreamId(null);
      refetch();
    } catch (err: any) {
      console.error("Delete failed:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleRegenerateToken = async (id: string) => {
    setActionLoading(id);
    try {
      await regenerateWebhookToken({ id });
      refetch();
    } catch (err: any) {
      console.error("Regenerate token failed:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleSelectIntegration = (integration: IntegrationDef) => {
    setSelectedIntegration(integration);
    setNewName(integration.label);
    setConnectStep("name");
  };

  const handleConnect = async () => {
    if (!newName.trim() || !selectedIntegration) return;
    setCreating(true);
    try {
      await createStream({
        name: newName.trim(),
        type: selectedIntegration.type || "webhook",
        source: selectedIntegration.value,
      });
      closeConnectDialog();
      refetch();
    } catch (err: any) {
      console.error("Create failed:", err);
    } finally {
      setCreating(false);
    }
  };

  const closeConnectDialog = () => {
    setShowConnectDialog(false);
    setConnectStep("pick");
    setSelectedIntegration(null);
    setNewName("");
  };

  // Compute per-source health summary
  const sourceStats = INTEGRATIONS.map((integration) => {
    const sourceStreams = streams?.filter((s: any) => s.source === integration.value) ?? [];
    const totalEvents = sourceStreams.reduce((sum: number, s: any) => sum + (s._count?.events ?? 0), 0);
    const hasError = sourceStreams.some((s: any) => s.status === "error");
    const activeCount = sourceStreams.filter((s: any) => s.enabled && s.status !== "paused").length;
    return { ...integration, connected: sourceStreams.length, totalEvents, hasError, activeCount };
  });

  const selectedStream = streams?.find((s: any) => s.id === selectedStreamId);

  return (
    <DashboardLayout>
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Radio className="h-5 w-5 text-gold" />
          <h1 className="font-serif text-2xl font-light text-cream">
            Integrations
          </h1>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 font-mono text-xs"
          onClick={() => setShowConnectDialog(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          Connect Integration
        </Button>
      </div>

      <p className="text-muted-foreground mb-6 text-sm">
        Connect apps and services to feed data into Alfred's intelligence
        pipeline. Each integration streams events that Alfred can learn from
        and act on.
      </p>

      {/* Integration source health overview */}
      {streams && !isLoading && (
        <div className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {sourceStats.map((stat) => {
            const Icon = stat.icon;
            return (
              <div
                key={stat.value}
                className="rounded-sm border border-gold-dim/20 bg-black/20 px-3 py-2.5 text-center"
              >
                <Icon className="mx-auto mb-1.5 h-4 w-4 text-muted-foreground/60" />
                <p className="font-mono text-[0.6rem] font-medium uppercase tracking-wider text-cream/80">
                  {stat.label}
                </p>
                {stat.connected > 0 ? (
                  <div className="mt-1 flex items-center justify-center gap-1.5">
                    <span
                      className={`inline-block h-1.5 w-1.5 rounded-full ${
                        stat.hasError
                          ? "bg-red-500"
                          : stat.activeCount > 0
                            ? "bg-green-500"
                            : "bg-[#8A8680]/40"
                      }`}
                    />
                    <span className="font-mono text-[0.55rem] text-muted-foreground/50">
                      {stat.totalEvents} events
                    </span>
                  </div>
                ) : (
                  <p className="mt-1 font-mono text-[0.55rem] text-muted-foreground/30">
                    not connected
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 py-8">
          <Loader2 className="h-5 w-5 animate-spin text-gold" />
          <span className="text-muted-foreground text-sm">
            Loading integrations...
          </span>
        </div>
      )}

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-sm p-4">
          <p>{error.message}</p>
        </div>
      )}

      {streams && streams.length === 0 && (
        <div className="rounded-sm border border-gold-dim/20 bg-black/20 p-8 text-center">
          <Radio className="mx-auto mb-3 h-10 w-10 text-muted-foreground/30" />
          <p className="font-mono text-sm text-muted-foreground">
            No integrations connected yet
          </p>
          <p className="mt-1 font-mono text-xs text-muted-foreground/50">
            Connect an app to start streaming events into Alfred
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4 gap-1.5 font-mono text-xs"
            onClick={() => setShowConnectDialog(true)}
          >
            <Plus className="h-3.5 w-3.5" />
            Connect Your First Integration
          </Button>
        </div>
      )}

      {streams && streams.length > 0 && (
        <div className="space-y-2">
          {streams.map((stream: any) => (
            <StreamCard
              key={stream.id}
              stream={stream}
              sourceIcon={INTEGRATIONS.find((i) => i.value === stream.source)?.icon}
              onPause={handlePause}
              onResume={handleResume}
              onDelete={(id) => {
                const s = streams?.find((st: any) => st.id === id);
                if (s?.isSystem) return;
                setShowDeleteConfirm(id);
              }}
              onRegenerateToken={handleRegenerateToken}
              onClick={setSelectedStreamId}
              actionLoading={actionLoading}
            />
          ))}
        </div>
      )}

      {/* Event Log drawer */}
      {selectedStream && (
        <div className="mt-4">
          <EventLog
            streamId={selectedStream.id}
            streamName={selectedStream.name}
            onClose={() => setSelectedStreamId(null)}
          />
        </div>
      )}

      {/* Connect Integration Dialog */}
      <Dialog
        open={showConnectDialog}
        onOpenChange={(open) => {
          if (!open) closeConnectDialog();
        }}
      >
        <DialogContent className="border-gold-dim bg-[#0A0A0A] sm:max-w-lg">
          {connectStep === "pick" ? (
            <>
              <DialogHeader>
                <DialogTitle className="text-cream font-serif font-light">
                  Connect Integration
                </DialogTitle>
                <DialogDescription>
                  Choose a service to connect. Alfred will start receiving events
                  from the integration automatically.
                </DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-2 py-2">
                {INTEGRATIONS.map((integration) => {
                  const Icon = integration.icon;
                  return (
                    <button
                      key={integration.value}
                      type="button"
                      className="group flex flex-col items-start gap-2 rounded-sm border border-gold-dim/20 bg-black/20 p-3 text-left transition-colors hover:border-gold-dim/60 hover:bg-black/40"
                      onClick={() => handleSelectIntegration(integration)}
                    >
                      <div className="flex items-center gap-2">
                        <Icon className="h-4 w-4 text-gold/70 group-hover:text-gold" />
                        <span className="font-mono text-xs font-medium uppercase tracking-wider text-cream">
                          {integration.label}
                        </span>
                      </div>
                      <p className="font-mono text-[0.6rem] leading-relaxed text-muted-foreground/60">
                        {integration.description}
                      </p>
                      <span className="mt-auto inline-block rounded-sm bg-gold/10 px-1.5 py-0.5 font-mono text-[0.5rem] uppercase tracking-wider text-gold/60">
                        {integration.type}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="text-muted-foreground transition-colors hover:text-cream"
                    onClick={() => setConnectStep("pick")}
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </button>
                  <DialogTitle className="text-cream font-serif font-light">
                    Connect {selectedIntegration?.label}
                  </DialogTitle>
                </div>
                <DialogDescription>
                  {selectedIntegration?.description}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <label className="mb-1.5 block font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground">
                    Integration Name
                  </label>
                  <Input
                    placeholder={`e.g. ${selectedIntegration?.label} Primary`}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !creating && handleConnect()}
                    autoFocus
                  />
                </div>
                <div className="rounded-sm border border-gold-dim/20 bg-black/20 px-3 py-2">
                  <p className="font-mono text-[0.6rem] text-muted-foreground">
                    Type:{" "}
                    <span className="text-cream">
                      {selectedIntegration?.type}
                    </span>
                  </p>
                  {selectedIntegration?.type === "webhook" && (
                    <p className="mt-1 font-mono text-[0.55rem] text-muted-foreground/50">
                      A unique webhook URL will be generated after connecting
                    </p>
                  )}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={closeConnectDialog}>
                    Cancel
                  </Button>
                  <Button
                    onClick={handleConnect}
                    disabled={creating || !newName.trim()}
                  >
                    {creating ? "Connecting..." : "Connect"}
                  </Button>
                </DialogFooter>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={!!showDeleteConfirm}
        onOpenChange={(open) => {
          if (!open) setShowDeleteConfirm(null);
        }}
      >
        <DialogContent className="border-gold-dim bg-[#0A0A0A]">
          <DialogHeader>
            <DialogTitle className="text-cream font-serif font-light">
              Disconnect Integration
            </DialogTitle>
            <DialogDescription>
              This will permanently remove this integration and all its events.
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteConfirm(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                showDeleteConfirm && handleDelete(showDeleteConfirm)
              }
              disabled={!!actionLoading}
            >
              {actionLoading ? "Disconnecting..." : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
