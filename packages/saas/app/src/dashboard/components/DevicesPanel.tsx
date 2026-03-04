import { useState } from "react";
import {
  useQuery,
  getDevices,
  approveDevice,
  rejectDevice,
  removeDevice,
} from "wasp/client/operations";
import { Button } from "../../client/components/ui/button";
import { Loader2 } from "lucide-react";

type Tab = "paired" | "pending" | "rejected";

export default function DevicesPanel() {
  const [tab, setTab] = useState<Tab>("paired");
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const { data: devicesData, refetch } = useQuery(getDevices, undefined, {
    refetchInterval: 15_000,
  });

  const pendingDevices: any[] = devicesData?.pending ?? [];
  const pairedDevices: any[] = devicesData?.paired ?? [];

  const handleApprove = async (requestId: string) => {
    setActionLoading(requestId);
    try {
      await approveDevice({ requestId });
      refetch();
    } catch (err) {
      console.error("Approve failed:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async (requestId: string) => {
    setActionLoading(requestId);
    try {
      await rejectDevice({ requestId });
      refetch();
    } catch (err) {
      console.error("Reject failed:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleRemove = async (deviceId: string) => {
    setActionLoading(deviceId);
    try {
      await removeDevice({ deviceId });
      refetch();
    } catch (err) {
      console.error("Remove failed:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "paired", label: "Paired", count: pairedDevices.length },
    { key: "pending", label: "Pending", count: pendingDevices.length },
    { key: "rejected", label: "Rejected" },
  ];

  return (
    <div className="overflow-hidden rounded-sm border border-gold-dim/20 bg-black/20 transition-all">
      {/* Tab bar */}
      <div className="flex border-b border-gold-dim/20">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={`px-4 py-2 font-mono text-[0.65rem] uppercase tracking-[0.15em] transition-colors ${
              tab === t.key
                ? "border-b-2 border-gold text-cream"
                : "text-muted-foreground/60 hover:text-muted-foreground"
            }`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.count !== undefined && t.count > 0 && (
              <span className="ml-1.5 text-muted-foreground/40">
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="p-3">
        {tab === "paired" && (
          <>
            {pairedDevices.length === 0 ? (
              <p className="py-2 text-center font-mono text-xs text-muted-foreground/50">
                No devices paired yet
              </p>
            ) : (
              <div className="space-y-1">
                {pairedDevices.map((device: any) => {
                  const id = device.deviceId || device.id;
                  return (
                    <div
                      key={id}
                      className="group flex items-center gap-3 rounded-sm px-3 py-2 hover:bg-gold/5"
                    >
                      <div className="h-2 w-2 flex-shrink-0 rounded-full bg-green-500" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-cream">
                        {device.clientId ||
                          device.deviceName ||
                          device.platform ||
                          "Device"}
                      </span>
                      <span className="font-mono text-[0.6rem] text-muted-foreground/50">
                        {device.platform || "—"}
                      </span>
                      <span className="font-mono text-[0.6rem] text-muted-foreground/40">
                        —
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 border-red-500/30 px-2 font-mono text-[0.6rem] text-red-400 opacity-0 transition-opacity hover:bg-red-500/10 group-hover:opacity-100"
                        disabled={actionLoading === id}
                        onClick={() => handleRemove(id)}
                      >
                        {actionLoading === id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          "Unpair"
                        )}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {tab === "pending" && (
          <>
            {pendingDevices.length === 0 ? (
              <p className="py-2 text-center font-mono text-xs text-muted-foreground/50">
                No pending requests
              </p>
            ) : (
              <div className="space-y-1">
                {pendingDevices.map((device: any) => {
                  const id = device.id || device.requestId;
                  return (
                    <div
                      key={id}
                      className="flex items-center gap-3 rounded-sm px-3 py-2 hover:bg-gold/5"
                    >
                      <div className="h-2 w-2 flex-shrink-0 rounded-full bg-amber-500" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-cream">
                        {device.clientId ||
                          device.deviceName ||
                          device.platform ||
                          "Unknown device"}
                      </span>
                      <span className="font-mono text-[0.6rem] text-muted-foreground/50">
                        {device.platform || "—"}
                      </span>
                      <div className="flex gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 border-green-500/30 px-2 font-mono text-[0.6rem] text-green-400 hover:bg-green-500/10"
                          disabled={actionLoading === id}
                          onClick={() => handleApprove(id)}
                        >
                          {actionLoading === id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            "Approve"
                          )}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 border-red-500/30 px-2 font-mono text-[0.6rem] text-red-400 hover:bg-red-500/10"
                          disabled={actionLoading === id}
                          onClick={() => handleReject(id)}
                        >
                          Reject
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {tab === "rejected" && (
          <p className="py-2 text-center font-mono text-xs text-muted-foreground/50">
            None
          </p>
        )}
      </div>
    </div>
  );
}
