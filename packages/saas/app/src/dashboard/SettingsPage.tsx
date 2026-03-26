import { useState, Suspense } from "react";
import { useAuth } from "wasp/client/auth";
import { useSearchParams } from "react-router-dom";
import {
  useQuery,
  getCustomerPortalUrl,
  listApiKeys,
  createApiKey,
  revokeApiKey,
} from "wasp/client/operations";
import DashboardLayout from "./DashboardLayout";
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
  ExternalLink,
  Plus,
  Trash2,
  Copy,
  Key,
  BookOpen,
  Server,
  KeyRound,
  FolderOpen,
  ScrollText,
  TerminalSquare,
  UserCog,
  Loader2,
} from "lucide-react";
import { cn } from "../client/utils";

import { AssistantsContent } from "./AssistantsPage";
import { CredentialsContent } from "./CredentialsPage";
import { WorkspaceContent } from "./WorkspacePage";
import { LogsContent } from "./LogsPage";
import { TerminalContent } from "./TerminalPage";

/* ------------------------------------------------------------------ */
/*  Tab definitions                                                     */
/* ------------------------------------------------------------------ */

interface SettingsTab {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const SETTINGS_TABS: SettingsTab[] = [
  { id: "services", label: "Services", icon: Server },
  { id: "credentials", label: "Credentials", icon: KeyRound },
  { id: "workspace", label: "Workspace", icon: FolderOpen },
  { id: "logs", label: "Logs", icon: ScrollText },
  { id: "terminal", label: "Terminal", icon: TerminalSquare },
  { id: "account", label: "Account", icon: UserCog },
];

const VALID_TAB_IDS = new Set(SETTINGS_TABS.map((t) => t.id));

/* ------------------------------------------------------------------ */
/*  Unified Settings Page                                               */
/* ------------------------------------------------------------------ */

export default function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab") || "services";
  const activeTab = VALID_TAB_IDS.has(tabParam) ? tabParam : "services";

  const setActiveTab = (tab: string) => {
    setSearchParams({ tab }, { replace: true });
  };

  return (
    <DashboardLayout>
      <h1 className="font-serif mb-6 text-2xl font-light text-cream">Settings</h1>

      {/* Tab navigation */}
      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-gold-dim/40 pb-px">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "flex items-center gap-2 whitespace-nowrap px-4 py-2.5 font-mono text-xs uppercase tracking-wider transition-colors",
              activeTab === tab.id
                ? "border-b-2 border-gold text-gold"
                : "text-[#8A8680] hover:text-[#E8E4DE]",
            )}
          >
            <tab.icon className="h-3.5 w-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-gold" />
          </div>
        }
      >
        {activeTab === "services" && <AssistantsContent />}
        {activeTab === "credentials" && <CredentialsContent />}
        {activeTab === "workspace" && <WorkspaceContent />}
        {activeTab === "logs" && <LogsContent />}
        {activeTab === "terminal" && <TerminalContent />}
        {activeTab === "account" && <AccountContent />}
      </Suspense>
    </DashboardLayout>
  );
}

/* ------------------------------------------------------------------ */
/*  Account content (previously the entire SettingsPage)                */
/* ------------------------------------------------------------------ */

export function AccountContent() {
  const { data: user } = useAuth();
  const {
    data: portalUrl,
    isLoading: portalLoading,
    error: portalError,
  } = useQuery(getCustomerPortalUrl);

  return (
    <>
      <h2 className="font-serif mb-6 text-xl font-light text-cream">Account</h2>

      <div className="space-y-6">
        {/* Account Info */}
        <Card>
          <CardContent className="p-6">
            <CardTitle className="text-cream mb-4 text-lg">
              Account
            </CardTitle>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Email</dt>
                <dd className="text-foreground">{user?.email || "-"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Plan</dt>
                <dd className="text-foreground capitalize">
                  {user?.subscriptionPlan || "None"}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Subscription Status</dt>
                <dd className="text-foreground capitalize">
                  {user?.subscriptionStatus?.replace(/_/g, " ") || "None"}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        {/* Subscription Management */}
        <Card>
          <CardContent className="p-6">
            <CardTitle className="text-cream mb-4 text-lg">
              Subscription
            </CardTitle>
            <p className="text-muted-foreground mb-4 text-sm">
              Manage your subscription, update payment methods, or cancel through
              the customer portal.
            </p>
            {portalError && (
              <div className="bg-destructive/10 text-destructive mb-4 rounded-sm p-3 text-sm">
                <p>Failed to load subscription portal: {portalError.message}</p>
              </div>
            )}
            {portalUrl ? (
              <Button
                onClick={() => window.open(portalUrl, "_blank")}
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                Manage Subscription
              </Button>
            ) : (
              <Button disabled={portalLoading || !!portalError}>
                {portalLoading ? "Loading..." : "No active subscription"}
              </Button>
            )}
          </CardContent>
        </Card>

        {/* API Keys */}
        <ApiKeysSection />
      </div>
    </>
  );
}

function ApiKeysSection() {
  const { data: keys, isLoading } = useQuery(listApiKeys);
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleCreate = async () => {
    if (!newKeyName.trim()) return;
    setCreating(true);
    try {
      const result = await createApiKey({ name: newKeyName.trim() });
      setCreatedKey(result.key);
      setNewKeyName("");
    } catch (e: any) {
      alert(e.message || "Failed to create API key");
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    if (!confirm("Revoke this API key? Any scripts using it will stop working.")) return;
    setRevoking(id);
    try {
      await revokeApiKey({ id });
    } catch (e: any) {
      alert(e.message || "Failed to revoke API key");
    } finally {
      setRevoking(null);
    }
  };

  const handleCopy = () => {
    if (createdKey) {
      navigator.clipboard.writeText(createdKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleCloseDialog = () => {
    setShowCreate(false);
    setCreatedKey(null);
    setNewKeyName("");
    setCopied(false);
  };

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <CardTitle className="text-cream text-lg">
            API Keys
          </CardTitle>
          <div className="flex gap-2">
            <a href="https://alfred.black/docs" target="_blank" rel="noopener noreferrer">
              <Button variant="ghost" size="sm">
                <BookOpen className="mr-1.5 h-3.5 w-3.5" />
                Docs
              </Button>
            </a>
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Create Key
            </Button>
          </div>
        </div>

        <p className="text-muted-foreground mb-4 text-sm">
          Use API keys to access your Alfred instance directly from scripts,
          automations, or third-party integrations.
        </p>

        {isLoading ? (
          <p className="text-muted-foreground text-sm">Loading...</p>
        ) : keys && keys.length > 0 ? (
          <div className="space-y-2">
            {keys.map((k: any) => (
              <div
                key={k.id}
                className="flex items-center justify-between rounded-sm border border-gold-dim/40 px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <Key className="text-muted-foreground h-4 w-4" />
                  <div>
                    <p className="text-foreground text-sm font-medium">{k.name}</p>
                    <p className="text-muted-foreground font-mono text-xs">
                      {k.keyPrefix}...
                      <span className="ml-3">
                        Created {new Date(k.createdAt).toLocaleDateString()}
                      </span>
                      {k.lastUsedAt && (
                        <span className="ml-3">
                          Last used {new Date(k.lastUsedAt).toLocaleDateString()}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleRevoke(k.id)}
                  disabled={revoking === k.id}
                >
                  <Trash2 className="h-4 w-4 text-red-400" />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            No API keys yet. Create one to get started.
          </p>
        )}

        {/* Create Key Dialog */}
        <Dialog open={showCreate} onOpenChange={(open) => !open && handleCloseDialog()}>
          <DialogContent className="border-gold-dim bg-[#0A0A0A]">
            <DialogHeader>
              <DialogTitle className="text-cream font-serif font-light">
                {createdKey ? "API Key Created" : "Create API Key"}
              </DialogTitle>
              <DialogDescription>
                {createdKey
                  ? "Copy your API key now. You won't be able to see it again."
                  : "Give your key a name to help you remember what it's for."}
              </DialogDescription>
            </DialogHeader>

            {createdKey ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <code className="bg-card flex-1 overflow-auto rounded-sm border border-gold-dim/40 px-3 py-2 font-mono text-xs text-gold">
                    {createdKey}
                  </code>
                  <Button variant="outline" size="icon" onClick={handleCopy}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                {copied && (
                  <p className="text-xs text-green-400">Copied to clipboard</p>
                )}
                <DialogFooter>
                  <Button onClick={handleCloseDialog}>Done</Button>
                </DialogFooter>
              </div>
            ) : (
              <div className="space-y-4">
                <Input
                  placeholder="e.g. My Script, Zapier Integration"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                />
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={handleCloseDialog}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleCreate}
                    disabled={creating || !newKeyName.trim()}
                  >
                    {creating ? "Creating..." : "Create"}
                  </Button>
                </DialogFooter>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
