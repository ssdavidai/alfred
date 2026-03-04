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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../client/components/ui/select";
import { Plus, Radio, Loader2 } from "lucide-react";
import StreamCard from "./components/StreamCard";
import EventLog from "./components/EventLog";

const STREAM_SOURCES = [
  { value: "openclaw", label: "OpenClaw Sessions" },
  { value: "gmail", label: "Gmail" },
  { value: "omi", label: "Omi Ambient" },
  { value: "polar", label: "Polar Payments" },
  { value: "github", label: "GitHub" },
  { value: "custom", label: "Custom" },
];

const SOURCE_TO_TYPE: Record<string, string> = {
  openclaw: "scheduled",
  gmail: "scheduled",
  omi: "realtime",
  polar: "webhook",
  github: "webhook",
  custom: "webhook",
};

export default function StreamsPage() {
  const { data: streams, isLoading, error, refetch } = useQuery(getStreams);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [selectedStreamId, setSelectedStreamId] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);

  // Create form state
  const [newName, setNewName] = useState("");
  const [newSource, setNewSource] = useState("custom");
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

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await createStream({
        name: newName.trim(),
        type: SOURCE_TO_TYPE[newSource] || "webhook",
        source: newSource,
      });
      setShowCreateDialog(false);
      setNewName("");
      setNewSource("custom");
      refetch();
    } catch (err: any) {
      console.error("Create failed:", err);
    } finally {
      setCreating(false);
    }
  };

  const selectedStream = streams?.find((s: any) => s.id === selectedStreamId);

  return (
    <DashboardLayout>
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Radio className="h-5 w-5 text-gold" />
          <h1 className="font-serif text-2xl font-light text-cream">
            Streams
          </h1>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 font-mono text-xs"
          onClick={() => setShowCreateDialog(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          Add Stream
        </Button>
      </div>

      <p className="text-muted-foreground mb-6 text-sm">
        Data pipelines that capture events from external sources and deliver
        them to Alfred's inbox.
      </p>

      {isLoading && (
        <div className="flex items-center gap-2 py-8">
          <Loader2 className="h-5 w-5 animate-spin text-gold" />
          <span className="text-muted-foreground text-sm">
            Loading streams...
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
            No streams configured yet
          </p>
          <p className="mt-1 font-mono text-xs text-muted-foreground/50">
            Add a stream to start capturing events from external sources
          </p>
        </div>
      )}

      {streams && streams.length > 0 && (
        <div className="space-y-2">
          {streams.map((stream: any) => (
            <StreamCard
              key={stream.id}
              stream={stream}
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

      {/* Create Stream Dialog */}
      <Dialog
        open={showCreateDialog}
        onOpenChange={(open) => {
          if (!open) {
            setShowCreateDialog(false);
            setNewName("");
            setNewSource("custom");
          }
        }}
      >
        <DialogContent className="border-gold-dim bg-[#0A0A0A]">
          <DialogHeader>
            <DialogTitle className="text-cream font-serif font-light">
              Add Stream
            </DialogTitle>
            <DialogDescription>
              Configure a new data pipeline to capture events from an external
              source.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground">
                Source
              </label>
              <Select value={newSource} onValueChange={setNewSource}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-gold-dim bg-[#0A0A0A]">
                  {STREAM_SOURCES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1.5 block font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground">
                Name
              </label>
              <Input
                placeholder="e.g. Gmail Primary, Polar Payments"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                autoFocus
              />
            </div>
            <div className="rounded-sm border border-gold-dim/20 bg-black/20 px-3 py-2">
              <p className="font-mono text-[0.6rem] text-muted-foreground">
                Type:{" "}
                <span className="text-cream">
                  {SOURCE_TO_TYPE[newSource] || "webhook"}
                </span>
              </p>
              {(SOURCE_TO_TYPE[newSource] || "webhook") === "webhook" && (
                <p className="mt-1 font-mono text-[0.55rem] text-muted-foreground/50">
                  A unique webhook URL will be generated after creation
                </p>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowCreateDialog(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreate}
                disabled={creating || !newName.trim()}
              >
                {creating ? "Creating..." : "Create Stream"}
              </Button>
            </DialogFooter>
          </div>
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
              Delete Stream
            </DialogTitle>
            <DialogDescription>
              This will permanently delete this stream and all its events. This
              action cannot be undone.
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
              {actionLoading ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
