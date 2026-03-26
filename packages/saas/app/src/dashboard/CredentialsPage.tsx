import { useState } from "react";
import {
  useQuery,
  getCredentials,
  updateCredentials,
} from "wasp/client/operations";
import { Navigate } from "react-router-dom";
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
import { KeyRound, CheckCircle, XCircle, Trash2, Loader2 } from "lucide-react";

interface Credential {
  key: string;
  label: string;
  description: string;
  set: boolean;
  masked: string | null;
  used_by: string[];
}

/** Inner content — used by the unified Settings page */
export function CredentialsContent() {
  const { data, isLoading, error, refetch } = useQuery(getCredentials);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState<string | null>(null);

  const credentials: Credential[] = data?.credentials || [];

  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const handleSave = async () => {
    if (!editKey || !editValue.trim()) return;
    setSaving(true);
    setStatusMessage(null);
    try {
      await updateCredentials({ [editKey]: editValue.trim() });
      setEditKey(null);
      setEditValue("");
      setStatusMessage("Credential saved. Services are restarting...");
      setTimeout(() => { refetch(); setStatusMessage(null); }, 5000);
    } catch (e: any) {
      // A 504 timeout is expected — the credential was likely saved but
      // the container restart took longer than the proxy timeout.
      if (e.message?.includes("504") || e.message?.includes("timed out")) {
        setEditKey(null);
        setEditValue("");
        setStatusMessage("Credential saved. Services are restarting (this may take ~30s)...");
        setTimeout(() => { refetch(); setStatusMessage(null); }, 8000);
      } else {
        alert(e.message || "Failed to update credential");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (key: string) => {
    setSaving(true);
    try {
      await updateCredentials({ [key]: null });
      setRemoveConfirm(null);
      setTimeout(() => refetch(), 1000);
    } catch (e: any) {
      alert(e.message || "Failed to remove credential");
    } finally {
      setSaving(false);
    }
  };

  const editingCred = credentials.find((c) => c.key === editKey);

  return (
    <>
      <h1 className="font-serif mb-2 text-2xl font-light text-cream">
        Credentials
      </h1>
      <p className="text-muted-foreground mb-6 text-sm">
        Manage API keys for LLM providers. Changes restart the Alfred worker
        automatically.
      </p>

      {statusMessage && (
        <div className="mb-4 flex items-center gap-2 rounded-sm border border-gold/30 bg-gold/5 px-4 py-3">
          <Loader2 className="h-4 w-4 animate-spin text-gold" />
          <p className="text-sm text-gold">{statusMessage}</p>
        </div>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 py-8">
          <Loader2 className="h-5 w-5 animate-spin text-gold" />
          <span className="text-muted-foreground text-sm">
            Loading credentials...
          </span>
        </div>
      )}

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-sm p-4">
          <p>{error.message}</p>
        </div>
      )}

      {!isLoading && !error && (
        <div className="space-y-4">
          {credentials.map((cred) => (
            <Card key={cred.key}>
              <CardContent className="p-6">
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-4">
                    <div className="mt-0.5">
                      {cred.set ? (
                        <CheckCircle className="h-5 w-5 text-green-500" />
                      ) : (
                        <XCircle className="h-5 w-5 text-[#8A8680]" />
                      )}
                    </div>
                    <div>
                      <CardTitle className="text-cream text-base">
                        {cred.label}
                      </CardTitle>
                      <p className="text-muted-foreground mt-1 text-sm">
                        {cred.description}
                      </p>
                      {cred.set && cred.masked && (
                        <p className="mt-2 font-mono text-xs text-gold/70">
                          {cred.masked}
                        </p>
                      )}
                      <p className="text-muted-foreground mt-2 text-xs">
                        Used by: {cred.used_by.join(", ")}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditKey(cred.key);
                        setEditValue("");
                      }}
                    >
                      <KeyRound className="mr-1.5 h-3 w-3" />
                      {cred.set ? "Update" : "Set Key"}
                    </Button>
                    {cred.set && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setRemoveConfirm(cred.key)}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-red-400" />
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Edit Key Dialog */}
      <Dialog
        open={!!editKey}
        onOpenChange={(open) => {
          if (!open) {
            setEditKey(null);
            setEditValue("");
          }
        }}
      >
        <DialogContent className="border-gold-dim bg-[#0A0A0A]">
          <DialogHeader>
            <DialogTitle className="text-cream font-serif font-light">
              {editingCred?.set ? "Update" : "Set"} {editingCred?.label} Key
            </DialogTitle>
            <DialogDescription>
              Enter your API key for {editingCred?.label}. The Alfred worker
              will restart to apply the change.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Input
              type="password"
              placeholder={`Paste your ${editingCred?.label} API key`}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
              autoFocus
            />
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setEditKey(null);
                  setEditValue("");
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={saving || !editValue.trim()}
              >
                {saving ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* Remove Confirmation Dialog */}
      <Dialog
        open={!!removeConfirm}
        onOpenChange={(open) => {
          if (!open) setRemoveConfirm(null);
        }}
      >
        <DialogContent className="border-gold-dim bg-[#0A0A0A]">
          <DialogHeader>
            <DialogTitle className="text-cream font-serif font-light">
              Remove Credential
            </DialogTitle>
            <DialogDescription>
              This will remove the{" "}
              {credentials.find((c) => c.key === removeConfirm)?.label} API key
              from your instance. Features that depend on it will stop working.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => removeConfirm && handleRemove(removeConfirm)}
              disabled={saving}
            >
              {saving ? "Removing..." : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function CredentialsPage() {
  return <Navigate to="/dashboard/settings?tab=credentials" replace />;
}
