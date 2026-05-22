// DevicesPage — Hermes-native DM pairing (issue #42).
//
// HISTORY. The old page wrapped an OpenClaw-era "devices" surface (per-device
// gateway tokens; approve/reject by request id). Hermes has no such concept.
// Its native equivalent is **DM pairing**: when an unknown messaging account
// DMs the gateway it gets a one-hour 8-char pairing code, and the owner
// approves that code by `platform` + `code`.
//
// Native `hermes pairing list` emits human-readable text only (no JSON, no
// stable per-row id), so this page is a read-only status surface for the
// list, plus a small form to approve a pending code by platform + code —
// the only two inputs the native CLI takes. Command approval is no longer
// surfaced here at all: it is now Hermes-native (`approvals.mode`).
import { useQuery, getDevices, approveDevice } from "wasp/client/operations";
import { Navigate } from "react-router-dom";
import DashboardLayout from "./DashboardLayout";
import { Card, CardContent } from "../client/components/ui/card";
import { Button } from "../client/components/ui/button";
import { MessageSquare, Check } from "lucide-react";
import { useState } from "react";

// F46 — /dashboard/devices → /channels. Device/DM pairing now lives under
// the Channels surface. The legacy pairing page is preserved verbatim as
// LegacyDevicesPage so the cutover can be reverted with one line.
export default function DevicesPage() {
  return <Navigate to="/channels" replace />;
}

function LegacyDevicesPage() {
  const { data, isLoading, error, refetch } = useQuery(getDevices);
  const [platform, setPlatform] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const raw: string =
    typeof (data as any)?.raw === "string" ? (data as any).raw : "";

  const handleApprove = async () => {
    if (!platform.trim() || !code.trim()) return;
    setBusy(true);
    setResult(null);
    setActionError(null);
    try {
      const res = await approveDevice({
        platform: platform.trim(),
        code: code.trim(),
      });
      setResult((res as any)?.message ?? "Pairing approved");
      setCode("");
      refetch();
    } catch (err: any) {
      setActionError(err?.message ?? "Approve failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <DashboardLayout>
      <h1 className="font-serif mb-2 text-2xl font-light text-cream">
        Pairings
      </h1>
      <p className="text-muted-foreground mb-6 max-w-[60ch] text-sm">
        Hermes pairs a messaging account with you instead of issuing device
        tokens. When an unknown account DMs Alfred it receives a one-hour
        8-character pairing code. Approve that code below to let the
        conversation reach Alfred.
      </p>

      {/* Approve a pending pairing code */}
      <Card className="mb-6">
        <CardContent className="p-4">
          <h2 className="text-cream mb-3 text-sm font-semibold">
            Approve a pairing code
          </h2>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs">Platform</span>
              <input
                className="bg-black/30 text-cream border-gold-dim/20 rounded-sm border px-2 py-1 font-mono text-sm"
                placeholder="telegram"
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs">
                Pairing code
              </span>
              <input
                className="bg-black/30 text-cream border-gold-dim/20 rounded-sm border px-2 py-1 font-mono text-sm uppercase"
                placeholder="XKGH5N7P"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            <Button
              size="sm"
              disabled={busy || !platform.trim() || !code.trim()}
              onClick={handleApprove}
            >
              <Check className="mr-1 h-3 w-3" />
              Approve
            </Button>
          </div>
          {result && (
            <p className="mt-3 font-mono text-xs text-green-400">{result}</p>
          )}
          {actionError && (
            <p className="text-destructive mt-3 font-mono text-xs">
              {actionError}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Pairing status — raw `hermes pairing list` output */}
      <h2 className="text-cream mb-2 text-lg font-semibold">Pairing status</h2>
      {isLoading && (
        <p className="text-muted-foreground">Loading pairings...</p>
      )}
      {error && (
        <div className="bg-destructive/10 text-destructive rounded-sm p-4">
          <p>{error.message}</p>
        </div>
      )}
      {!isLoading && !error && (
        <Card>
          <CardContent className="p-4">
            {raw ? (
              <pre className="text-muted-foreground whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                {raw}
              </pre>
            ) : (
              <div className="py-6 text-center">
                <MessageSquare className="text-muted-foreground mx-auto mb-3 h-10 w-10" />
                <p className="text-muted-foreground">
                  No pairings yet. Message Alfred from Telegram, Slack, or
                  another channel — you will receive a pairing code to approve
                  here.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </DashboardLayout>
  );
}
