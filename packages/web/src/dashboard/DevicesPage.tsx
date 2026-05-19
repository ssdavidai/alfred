// DevicesPage — Hermes DM-pairing / command-approval (#31).
//
// SEMANTIC SHIFT (PLAN.md Part F, issue #15): OpenClaw "devices" were
// per-device gateway tokens. Hermes has no device-token concept — its
// equivalent is **DM pairing**: a chat/DM (Telegram, Slack, Omi, …) is
// paired with the principal, and privileged commands require approval.
//
// The data still arrives via `getDevices` → ctrl-api `GET /api/v1/devices`,
// which now proxies `hermes -p main devices list --json`. The exact field
// names depend on the pinned Hermes build, so every read is tolerant: a
// pairing is identified by `id`/`requestId`/`deviceId`, described by
// `channel`/`platform`/`clientId`, and approved/rejected by request id.
import {
  useQuery,
  getDevices,
  approveDevice,
  rejectDevice,
} from "wasp/client/operations";
import DashboardLayout from "./DashboardLayout";
import { Card, CardContent } from "../client/components/ui/card";
import { Button } from "../client/components/ui/button";
import { MessageSquare, Check, X, Shield } from "lucide-react";
import { useState } from "react";

/** A pairing's stable id — Hermes builds vary, so accept the common keys. */
function pairingId(p: any): string {
  return String(p?.id ?? p?.requestId ?? p?.deviceId ?? p?.pairingId ?? "");
}

/** A human label for a pairing — channel + handle, falling back gracefully. */
function pairingLabel(p: any): string {
  return String(
    p?.channel ??
      p?.clientId ??
      p?.handle ??
      p?.platform ??
      p?.deviceName ??
      "DM pairing",
  );
}

/** The channel/transport a pairing arrived on (telegram, slack, omi, …). */
function pairingChannel(p: any): string {
  return String(p?.channel ?? p?.platform ?? p?.transport ?? "—");
}

export default function DevicesPage() {
  const { data, isLoading, error, refetch } = useQuery(getDevices);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

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

  const pending: any[] = Array.isArray((data as any)?.pending)
    ? (data as any).pending
    : [];
  const paired: any[] = Array.isArray((data as any)?.paired)
    ? (data as any).paired
    : [];

  return (
    <DashboardLayout>
      <h1 className="font-serif mb-2 text-2xl font-light text-cream">
        Pairings
      </h1>
      <p className="text-muted-foreground mb-6 max-w-[60ch] text-sm">
        Hermes pairs a chat or DM with you instead of issuing device tokens.
        Approve a pairing request to let that conversation reach Alfred;
        privileged commands from a paired DM still ask for your approval.
      </p>

      {isLoading && (
        <p className="text-muted-foreground">Loading pairings...</p>
      )}

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-sm p-4">
          <p>{error.message}</p>
        </div>
      )}

      {data && (
        <div className="space-y-4">
          {/* Pending pairing requests */}
          {pending.length > 0 && (
            <>
              <h2 className="text-cream text-lg font-semibold">
                Pairing requests
              </h2>
              {pending.map((req: any) => {
                const id = pairingId(req);
                return (
                  <Card key={id} className="border-primary/50 border">
                    <CardContent className="flex items-center justify-between p-4">
                      <div className="flex items-center gap-3">
                        <Shield className="text-primary h-5 w-5" />
                        <div>
                          <p className="text-cream font-medium">
                            {pairingLabel(req)}
                          </p>
                          <p className="text-muted-foreground text-xs">
                            {pairingChannel(req)}
                            {req?.createdAtMs
                              ? ` · requested ${new Date(
                                  req.createdAtMs,
                                ).toLocaleString()}`
                              : ""}
                          </p>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={actionLoading === id}
                          onClick={() => handleApprove(id)}
                        >
                          <Check className="mr-1 h-3 w-3" />
                          Approve
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={actionLoading === id}
                          onClick={() => handleReject(id)}
                        >
                          <X className="mr-1 h-3 w-3" />
                          Reject
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </>
          )}

          {/* Paired conversations */}
          <h2 className="text-cream text-lg font-semibold">
            Paired conversations
          </h2>
          {paired.length > 0 ? (
            paired.map((p: any) => {
              const id = pairingId(p);
              return (
                <Card key={id || pairingLabel(p)}>
                  <CardContent className="flex items-center gap-3 p-4">
                    <MessageSquare className="text-muted-foreground h-5 w-5" />
                    <div>
                      <p className="text-cream font-medium">
                        {pairingLabel(p)}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {pairingChannel(p)}
                        {p?.role ? ` · ${p.role}` : ""}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          ) : (
            <Card>
              <CardContent className="p-8 text-center">
                <MessageSquare className="text-muted-foreground mx-auto mb-3 h-12 w-12" />
                <p className="text-muted-foreground">
                  No conversations paired yet. Message Alfred from Telegram,
                  Slack, or another channel and approve the pairing request
                  here.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </DashboardLayout>
  );
}
