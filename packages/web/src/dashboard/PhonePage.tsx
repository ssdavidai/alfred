import { useState } from "react";
import {
  useQuery,
  getPhoneConfig,
  addAuthorizedNumber,
  removeAuthorizedNumber,
} from "wasp/client/operations";
import { Card, CardContent, CardTitle } from "../client/components/ui/card";
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
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  MessageSquare,
  Loader2,
  Trash2,
  Plus,
} from "lucide-react";

interface ActivityEvent {
  kind: "voice" | "sms";
  direction: "inbound" | "outbound";
  from?: string;
  to?: string;
  summary: string;
  at: string;
}

interface PhoneConfig {
  phoneNumber: string | null;
  authorizedNumbers: string[];
  recentActivity: ActivityEvent[];
}

function formatPhone(num: string | null | undefined): string {
  if (!num) return "—";
  // Light formatting: keep + and spaces every 3 digits after the country code.
  const cleaned = num.replace(/[^+\d]/g, "");
  if (cleaned.startsWith("+")) {
    const cc = cleaned.slice(1, 3);
    const rest = cleaned.slice(3);
    return `+${cc} ${rest.replace(/(\d{3})(?=\d)/g, "$1 ")}`;
  }
  return num;
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const seconds = Math.round((Date.now() - t) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

export default function PhonePage() {
  const { data, isLoading, error, refetch } = useQuery(getPhoneConfig);
  const cfg = data as PhoneConfig | undefined;

  const [adding, setAdding] = useState(false);
  const [addValue, setAddValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  const handleAdd = async () => {
    const n = addValue.trim();
    if (!n) return;
    setBusy(true);
    try {
      await addAuthorizedNumber({ number: n });
      setAddValue("");
      setAdding(false);
      refetch();
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (n: string) => {
    setBusy(true);
    try {
      await removeAuthorizedNumber({ number: n });
      setRemoveTarget(null);
      refetch();
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-6 text-red-600">
        Failed to load phone config: {String((error as Error).message)}
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-semibold">Phone</h1>

      {/* Number card */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-4">
            <Phone className="h-8 w-8 text-muted-foreground" />
            <div>
              <CardTitle className="text-base">Your Alfred line</CardTitle>
              {cfg?.phoneNumber ? (
                <div className="mt-1 text-2xl font-mono">
                  {formatPhone(cfg.phoneNumber)}
                </div>
              ) : (
                <div className="mt-1 text-sm text-muted-foreground">
                  Not yet provisioned. Re-run setup or contact support.
                </div>
              )}
            </div>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Anyone can call this number to reach Alfred — voice calls run in
            real-time with full tool access. Only numbers on the authorised
            list below get an SMS reply; messages from other numbers are
            stored as stream events for review.
          </p>
        </CardContent>
      </Card>

      {/* Authorised numbers */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Authorised SMS numbers</CardTitle>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAdding(true)}
              disabled={busy}
            >
              <Plus className="mr-1 h-4 w-4" /> Add number
            </Button>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Texts from these numbers go straight to Alfred and get an SMS
            reply. Others become stream events with no reply.
          </p>
          {cfg && cfg.authorizedNumbers.length > 0 ? (
            <ul className="mt-4 divide-y">
              {cfg.authorizedNumbers.map((n) => (
                <li
                  key={n}
                  className="flex items-center justify-between py-2"
                >
                  <span className="font-mono text-sm">{formatPhone(n)}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setRemoveTarget(n)}
                    disabled={busy}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">
              No authorised numbers yet. Add yours to start texting Alfred.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Recent activity */}
      <Card>
        <CardContent className="p-6">
          <CardTitle className="text-base">Recent activity</CardTitle>
          {cfg && cfg.recentActivity.length > 0 ? (
            <ul className="mt-4 divide-y">
              {cfg.recentActivity.map((e, i) => (
                <li
                  key={`${e.at}-${i}`}
                  className="flex items-start gap-3 py-2"
                >
                  <ActivityIcon
                    kind={e.kind}
                    direction={e.direction}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm">
                      <span className="font-medium">
                        {e.direction === "outbound"
                          ? formatPhone(e.to ?? "")
                          : formatPhone(e.from ?? "")}
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {formatRelative(e.at)}
                      </span>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {e.summary}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">
              No phone activity yet.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Add dialog */}
      <Dialog open={adding} onOpenChange={(o) => !o && setAdding(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add authorised number</DialogTitle>
            <DialogDescription>
              Use E.164 format (e.g. +15555550100). The number gets immediate
              SMS access to Alfred.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={addValue}
            onChange={(e) => setAddValue(e.target.value)}
            placeholder="+15555550100"
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAdding(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button onClick={handleAdd} disabled={busy || !addValue.trim()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove confirm */}
      <Dialog
        open={!!removeTarget}
        onOpenChange={(o) => !o && setRemoveTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove authorised number</DialogTitle>
            <DialogDescription>
              {removeTarget && formatPhone(removeTarget)} will no longer get
              SMS replies from Alfred.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRemoveTarget(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => removeTarget && handleRemove(removeTarget)}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Remove"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ActivityIcon({
  kind,
  direction,
}: {
  kind: "voice" | "sms";
  direction: "inbound" | "outbound";
}) {
  if (kind === "sms") {
    return <MessageSquare className="mt-0.5 h-4 w-4 text-muted-foreground" />;
  }
  return direction === "inbound" ? (
    <PhoneIncoming className="mt-0.5 h-4 w-4 text-muted-foreground" />
  ) : (
    <PhoneOutgoing className="mt-0.5 h-4 w-4 text-muted-foreground" />
  );
}
