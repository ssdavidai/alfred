import { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "wasp/client/auth";
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
  Plus,
  Radio,
  Loader2,
  ArrowLeft,
} from "lucide-react";
import StreamCard from "./components/StreamCard";
import EventLog from "./components/EventLog";
import { SOURCES, type SourceDefinition } from "./sources";

const TRANSPORT_LABELS: Record<string, string> = {
  pull: "Pull",
  push: "Webhook",
  realtime: "Realtime",
  system: "System",
};

export default function StreamsPage() {
  const { data: user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { data: streams, isLoading, error, refetch } = useQuery(getStreams);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [selectedStreamId, setSelectedStreamId] = useState<string | null>(null);
  const [showConnectDialog, setShowConnectDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);

  // Integration connect flow state
  const [connectStep, setConnectStep] = useState<"pick" | "name">("pick");
  const [selectedSource, setSelectedSource] = useState<SourceDefinition | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  // Handle OAuth redirect back
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const oauthStatus = params.get("oauth");
    const provider = params.get("provider");

    if (oauthStatus === "success" && provider) {
      // Find the source definition for this provider
      const source = SOURCES.find((s) => s.authProvider === provider);
      if (source) {
        // Auto-create the stream with canonical config
        const doCreate = async () => {
          setCreating(true);
          try {
            await createStream({
              name: source.label,
              type: source.transport === "pull" ? "scheduled" : source.transport === "push" ? "webhook" : source.transport,
              source: source.id,
              config: source.defaultConfig,
            });
            refetch();
          } catch (err: any) {
            console.error("Auto-create after OAuth failed:", err);
          } finally {
            setCreating(false);
          }
        };
        doCreate();
      }
      // Clean up URL params
      navigate("/dashboard/streams", { replace: true });
    }
  }, [location.search]);

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

  const handleSelectSource = (source: SourceDefinition) => {
    if (!source.available) return;

    if (source.authType === "oauth2" && source.authProvider && user) {
      // Redirect to OAuth flow
      const scopes = (source.requiredScopes ?? []).join(",");
      const redirectAfter = encodeURIComponent("/dashboard/streams");
      window.location.href = `/auth/oauth2/${source.authProvider}/start?userId=${user.id}&scopes=${scopes}&redirectAfter=${redirectAfter}`;
      return;
    }

    setSelectedSource(source);
    setNewName(source.label);
    setConnectStep("name");
  };

  const handleConnect = async () => {
    if (!newName.trim() || !selectedSource) return;
    setCreating(true);
    try {
      const type = selectedSource.transport === "pull" ? "scheduled" : selectedSource.transport === "push" ? "webhook" : selectedSource.transport;
      await createStream({
        name: newName.trim(),
        type,
        source: selectedSource.id,
        config: selectedSource.defaultConfig,
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
    setSelectedSource(null);
    setNewName("");
  };

  // Compute per-source health summary
  const sourceStats = SOURCES.map((source) => {
    const sourceStreams = streams?.filter((s: any) => s.source === source.id) ?? [];
    const totalEvents = sourceStreams.reduce((sum: number, s: any) => sum + (s._count?.events ?? 0), 0);
    const hasError = sourceStreams.some((s: any) => s.status === "error");
    const activeCount = sourceStreams.filter((s: any) => s.enabled && s.status !== "paused").length;
    return { ...source, connected: sourceStreams.length, totalEvents, hasError, activeCount };
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
                key={stat.id}
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
                    {stat.available ? "not connected" : "coming soon"}
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
              sourceIcon={SOURCES.find((s) => s.id === stream.source)?.icon}
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
                {SOURCES.map((source) => {
                  const Icon = source.icon;
                  return (
                    <button
                      key={source.id}
                      type="button"
                      disabled={!source.available}
                      className={`group flex flex-col items-start gap-2 rounded-sm border border-gold-dim/20 bg-black/20 p-3 text-left transition-colors ${
                        source.available
                          ? "hover:border-gold-dim/60 hover:bg-black/40"
                          : "cursor-not-allowed opacity-50"
                      }`}
                      onClick={() => handleSelectSource(source)}
                    >
                      <div className="flex w-full items-center gap-2">
                        <Icon className="h-4 w-4 text-gold/70 group-hover:text-gold" />
                        <span className="font-mono text-xs font-medium uppercase tracking-wider text-cream">
                          {source.label}
                        </span>
                        {!source.available && (
                          <span className="ml-auto rounded-sm bg-muted/20 px-1.5 py-0.5 font-mono text-[0.5rem] uppercase tracking-wider text-muted-foreground/60">
                            Soon
                          </span>
                        )}
                      </div>
                      <p className="font-mono text-[0.6rem] leading-relaxed text-muted-foreground/60">
                        {source.description}
                      </p>
                      <span className="mt-auto inline-block rounded-sm bg-gold/10 px-1.5 py-0.5 font-mono text-[0.5rem] uppercase tracking-wider text-gold/60">
                        {TRANSPORT_LABELS[source.transport] ?? source.transport}
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
                    Connect {selectedSource?.label}
                  </DialogTitle>
                </div>
                <DialogDescription>
                  {selectedSource?.description}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <label className="mb-1.5 block font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground">
                    Integration Name
                  </label>
                  <Input
                    placeholder={`e.g. ${selectedSource?.label} Primary`}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !creating && handleConnect()}
                    autoFocus
                  />
                </div>
                <div className="rounded-sm border border-gold-dim/20 bg-black/20 px-3 py-2">
                  <p className="font-mono text-[0.6rem] text-muted-foreground">
                    Transport:{" "}
                    <span className="text-cream">
                      {TRANSPORT_LABELS[selectedSource?.transport ?? ""] ?? selectedSource?.transport}
                    </span>
                  </p>
                  {selectedSource?.transport === "push" && (
                    <p className="mt-1 font-mono text-[0.55rem] text-muted-foreground/50">
                      A unique webhook URL will be generated after connecting
                    </p>
                  )}
                  {selectedSource?.transport === "pull" && (
                    <p className="mt-1 font-mono text-[0.55rem] text-muted-foreground/50">
                      Alfred will poll for new data on a schedule
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
