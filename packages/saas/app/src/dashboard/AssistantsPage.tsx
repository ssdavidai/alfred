import {
  useQuery,
  getWorkerStatus,
  getAgentConfig,
  getCredentials,
  triggerWorker,
  updateAgentModel,
  updateCredentials,
} from "wasp/client/operations";
import DashboardLayout from "./DashboardLayout";
import { Card, CardContent, CardTitle } from "../client/components/ui/card";
import { Button } from "../client/components/ui/button";
import { Input } from "../client/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../client/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../client/components/ui/dialog";
import {
  Play,
  Square,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  XCircle,
  Save,
  Loader2,
  AlertTriangle,
  KeyRound,
} from "lucide-react";
import { useState, useEffect, useMemo } from "react";

/* ------------------------------------------------------------------ */
/*  Model catalog                                                      */
/* ------------------------------------------------------------------ */

const MODEL_CATALOG = [
  {
    provider: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    prefix: "anthropic/",
    models: [
      { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6" },
      { id: "anthropic/claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5" },
      { id: "anthropic/claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
      { id: "anthropic/claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
      { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet" },
      { id: "anthropic/claude-3.5-haiku", name: "Claude 3.5 Haiku" },
    ],
  },
  {
    provider: "OpenAI",
    envKey: "OPENAI_API_KEY",
    prefix: "openai/",
    models: [
      { id: "openai/gpt-4.1", name: "GPT-4.1" },
      { id: "openai/gpt-4.1-mini", name: "GPT-4.1 Mini" },
      { id: "openai/gpt-4.1-nano", name: "GPT-4.1 Nano" },
      { id: "openai/o3", name: "o3" },
      { id: "openai/o4-mini", name: "o4-mini" },
      { id: "openai/gpt-4o", name: "GPT-4o" },
      { id: "openai/gpt-4o-mini", name: "GPT-4o Mini" },
    ],
  },
  {
    provider: "Google",
    envKey: "GOOGLE_API_KEY",
    prefix: "google/",
    models: [
      { id: "google/gemini-2.5-pro-preview", name: "Gemini 2.5 Pro" },
      { id: "google/gemini-2.5-flash-preview", name: "Gemini 2.5 Flash" },
      { id: "google/gemini-2.0-flash-001", name: "Gemini 2.0 Flash" },
    ],
  },
  {
    provider: "xAI",
    envKey: "XAI_API_KEY",
    prefix: "x-ai/",
    models: [
      { id: "x-ai/grok-3-beta", name: "Grok 3" },
      { id: "x-ai/grok-3-fast-beta", name: "Grok 3 Fast" },
      { id: "x-ai/grok-3-mini-beta", name: "Grok 3 Mini" },
    ],
  },
  {
    provider: "Meta (via OpenRouter)",
    envKey: null,
    prefix: "meta-llama/",
    models: [
      { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick" },
      { id: "meta-llama/llama-4-scout", name: "Llama 4 Scout" },
      { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B" },
    ],
  },
  {
    provider: "DeepSeek (via OpenRouter)",
    envKey: null,
    prefix: "deepseek/",
    models: [
      { id: "deepseek/deepseek-r1", name: "DeepSeek R1" },
      { id: "deepseek/deepseek-chat-v3-0324", name: "DeepSeek V3" },
    ],
  },
  {
    provider: "Mistral (via OpenRouter)",
    envKey: null,
    prefix: "mistralai/",
    models: [
      { id: "mistralai/mistral-large-2411", name: "Mistral Large" },
      { id: "mistralai/mistral-small-2503", name: "Mistral Small" },
    ],
  },
] as const;

const ENTER_CUSTOM = "__enter_custom__";

/* ------------------------------------------------------------------ */
/*  Provider / credential helpers                                      */
/* ------------------------------------------------------------------ */

function getRequiredProvider(modelId: string) {
  for (const group of MODEL_CATALOG) {
    if (group.envKey && modelId.startsWith(group.prefix)) {
      return { envKey: group.envKey, label: group.provider };
    }
  }
  return null;
}

function isModelAvailable(modelId: string, configuredKeys: Set<string>) {
  if (configuredKeys.has("OPENROUTER_API_KEY")) return true;
  const provider = getRequiredProvider(modelId);
  if (!provider) return false; // OpenRouter-only provider, needs OPENROUTER_API_KEY
  return configuredKeys.has(provider.envKey);
}

type CredIndicator = "configured" | "via-openrouter" | "missing";

function getCredentialIndicator(
  group: (typeof MODEL_CATALOG)[number],
  configuredKeys: Set<string>,
): CredIndicator {
  const hasOpenRouter = configuredKeys.has("OPENROUTER_API_KEY");
  if (group.envKey) {
    if (configuredKeys.has(group.envKey)) return "configured";
    if (hasOpenRouter) return "via-openrouter";
    return "missing";
  }
  // OpenRouter-only provider
  return hasOpenRouter ? "configured" : "missing";
}

function indicatorIcon(status: CredIndicator) {
  if (status === "configured") return <span className="text-green-400">&#10003;</span>;
  if (status === "via-openrouter") return <span className="text-yellow-400">&#9679;</span>;
  return <span className="text-red-400">&#10007;</span>;
}

/** Check if modelId exists in the catalog. */
function isInCatalog(modelId: string): boolean {
  for (const group of MODEL_CATALOG) {
    for (const m of group.models) {
      if (m.id === modelId) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const ASSISTANT_LABELS: Record<string, { name: string; description: string }> = {
  alfred: {
    name: "Alfred Worker",
    description: "Runs self-healing vault maintenance including Curator, Janitor, Distiller, and Surveyor",
  },
  openclaw: {
    name: "OpenClaw Gateway",
    description: "AI agent gateway for device connectivity and skill execution",
  },
  temporal: {
    name: "Temporal Engine",
    description: "Workflow orchestration for scheduled and triggered tasks",
  },
};

const AGENT_TABS = [
  { id: "main", label: "Alfred" },
  { id: "vault-curator", label: "Curator" },
  { id: "vault-janitor", label: "Janitor" },
  { id: "vault-distiller", label: "Distiller" },
  { id: "surveyor", label: "Surveyor" },
];

function statusIcon(state: string) {
  if (state === "running") return <CheckCircle className="h-5 w-5 text-green-500" />;
  if (state === "exited") return <XCircle className="h-5 w-5 text-red-500" />;
  return <AlertCircle className="h-5 w-5 text-yellow-500" />;
}

/* ------------------------------------------------------------------ */
/*  ModelSelect — reusable grouped model picker                        */
/* ------------------------------------------------------------------ */

function ModelSelect({
  value,
  onSelect,
  configuredKeys,
  placeholder,
}: {
  value: string;
  onSelect: (modelId: string) => void;
  configuredKeys: Set<string>;
  placeholder?: string;
}) {
  const [customMode, setCustomMode] = useState(false);
  const [customInput, setCustomInput] = useState("");

  // Only show text input when user explicitly clicks "Custom model ID..."
  if (customMode) {
    return (
      <div className="flex gap-2">
        <Input
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          placeholder="e.g. anthropic/claude-sonnet-4-5-20250929"
          className="flex-1"
          onKeyDown={(e) => {
            if (e.key === "Enter" && customInput.trim()) {
              onSelect(customInput.trim());
              setCustomMode(false);
            }
          }}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (customInput.trim()) {
              onSelect(customInput.trim());
              setCustomMode(false);
            }
          }}
          disabled={!customInput.trim()}
        >
          <Save className="mr-1 h-3 w-3" />
          Set
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setCustomMode(false);
            setCustomInput("");
          }}
        >
          Cancel
        </Button>
      </div>
    );
  }

  const valueInCatalog = value && isInCatalog(value);

  return (
    <Select
      value={value || undefined}
      onValueChange={(val) => {
        if (val === ENTER_CUSTOM) {
          setCustomMode(true);
          setCustomInput(value);
        } else {
          onSelect(val);
        }
      }}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder || "Select a model..."} />
      </SelectTrigger>
      <SelectContent>
        {/* If current value is not in catalog, show it as a selectable item */}
        {value && !valueInCatalog && (
          <SelectGroup>
            <SelectLabel className="text-muted-foreground">Current</SelectLabel>
            <SelectItem value={value}>{value}</SelectItem>
          </SelectGroup>
        )}
        {MODEL_CATALOG.map((group) => {
          const indicator = getCredentialIndicator(group, configuredKeys);
          return (
            <SelectGroup key={group.provider}>
              <SelectLabel className="flex items-center gap-2">
                {indicatorIcon(indicator)}
                <span>{group.provider}</span>
              </SelectLabel>
              {group.models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectGroup>
          );
        })}
        <SelectGroup>
          <SelectLabel className="text-muted-foreground">Other</SelectLabel>
          <SelectItem value={ENTER_CUSTOM}>Custom model ID...</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/* ------------------------------------------------------------------ */
/*  API Key Dialog                                                     */
/* ------------------------------------------------------------------ */

function ApiKeyDialog({
  open,
  onOpenChange,
  modelName,
  providerLabel,
  providerEnvKey,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  modelName: string;
  providerLabel: string;
  providerEnvKey: string | null;
  onSaved: () => void;
}) {
  const [keyType, setKeyType] = useState<"provider" | "openrouter">(
    providerEnvKey ? "provider" : "openrouter",
  );
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on open
  useEffect(() => {
    if (open) {
      setKeyType(providerEnvKey ? "provider" : "openrouter");
      setApiKey("");
      setError(null);
    }
  }, [open, providerEnvKey]);

  const envKeyToSave = keyType === "provider" && providerEnvKey
    ? providerEnvKey
    : "OPENROUTER_API_KEY";

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await updateCredentials({ [envKeyToSave]: apiKey.trim() });
      onSaved();
      onOpenChange(false);
    } catch (e: any) {
      setError(e.message || "Failed to save API key");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-gold" />
            API Key Required
          </DialogTitle>
          <DialogDescription>
            To use <strong>{modelName}</strong>, you need an API key.
            {providerEnvKey
              ? ` You can add a ${providerLabel} key directly, or use an OpenRouter key instead.`
              : " This model is available through OpenRouter."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Key type toggle — only show if provider has its own key */}
          {providerEnvKey && (
            <div className="flex gap-2">
              <Button
                variant={keyType === "provider" ? "default" : "outline"}
                size="sm"
                onClick={() => setKeyType("provider")}
                className="flex-1"
              >
                {providerLabel} Key
              </Button>
              <Button
                variant={keyType === "openrouter" ? "default" : "outline"}
                size="sm"
                onClick={() => setKeyType("openrouter")}
                className="flex-1"
              >
                OpenRouter Key
              </Button>
            </div>
          )}

          <div>
            <label className="text-muted-foreground mb-1 block text-xs uppercase tracking-wider">
              {envKeyToSave}
            </label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={`Paste your ${keyType === "provider" ? providerLabel : "OpenRouter"} API key`}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
              }}
            />
          </div>

          {error && (
            <p className="text-xs text-red-400">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !apiKey.trim()}>
            {saving ? (
              <>
                <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="mr-1.5 h-3 w-3" />
                Save Key &amp; Set Model
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function AssistantsPage() {
  const { data, isLoading, error, refetch } = useQuery(getWorkerStatus);
  // Lightweight query — returns agent list + surveyor config (no docker exec)
  const {
    data: agentConfig,
    isLoading: agentLoading,
  } = useQuery(getAgentConfig);
  const {
    data: credentialsData,
    refetch: refetchCredentials,
  } = useQuery(getCredentials);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("main");

  const configuredKeys = useMemo(() => {
    const keys = new Set<string>();
    if (credentialsData?.credentials) {
      for (const c of credentialsData.credentials) {
        if (c.set) keys.add(c.key);
      }
    }
    return keys;
  }, [credentialsData]);

  const handleAction = async (action: string, service: string) => {
    setActionLoading(`${action}-${service}`);
    try {
      await triggerWorker({ action, service });
      setTimeout(() => refetch(), 2000);
    } catch (err) {
      console.error("Action failed:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const onModelSaved = () => {
    refetchCredentials();
    setTimeout(() => refetch(), 3000);
  };

  return (
    <DashboardLayout>
      <h1 className="font-serif mb-6 text-2xl font-light text-cream">Services</h1>

      {isLoading && (
        <p className="text-muted-foreground">Loading assistant status...</p>
      )}

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-sm p-4">
          <p>{error.message}</p>
        </div>
      )}

      {data?.containers && (
        <div className="space-y-4">
          {data.containers
            .filter((c: any) => c.Service !== "init")
            .map((container: any) => {
              const label = ASSISTANT_LABELS[container.Service] || {
                name: container.Service,
                description: "",
              };
              return (
                <Card key={container.Service}>
                  <CardContent className="flex items-center justify-between p-6">
                    <div className="flex items-center gap-4">
                      {statusIcon(container.State)}
                      <div>
                        <CardTitle className="text-cream text-base">
                          {label.name}
                        </CardTitle>
                        <p className="text-muted-foreground text-sm">
                          {label.description}
                        </p>
                        <p className="text-muted-foreground mt-1 text-xs">
                          Status: {container.State} | Health:{" "}
                          {container.Health || "N/A"}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!!actionLoading}
                        onClick={() => handleAction("restart", container.Service)}
                      >
                        <RefreshCw className="mr-1 h-3 w-3" />
                        {actionLoading === `restart-${container.Service}`
                          ? "..."
                          : "Restart"}
                      </Button>
                      {container.State === "running" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!!actionLoading}
                          onClick={() => handleAction("stop", container.Service)}
                        >
                          <Square className="mr-1 h-3 w-3" />
                          Stop
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!!actionLoading}
                          onClick={() => handleAction("start", container.Service)}
                        >
                          <Play className="mr-1 h-3 w-3" />
                          Start
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
        </div>
      )}

      {/* Agent Models Section */}
      <h2 className="font-serif mb-4 mt-10 text-xl font-light text-cream">
        Agent Models
      </h2>

      {agentLoading && (
        <div className="flex items-center gap-2 py-4">
          <Loader2 className="h-4 w-4 animate-spin text-gold" />
          <span className="text-muted-foreground text-sm">Loading agent config...</span>
        </div>
      )}

      {agentConfig && (
        <>
          {/* Tab navigation */}
          <div className="border-gold-dim/30 mb-4 flex border-b">
            {AGENT_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? "border-gold text-gold border-b-2"
                    : "text-muted-foreground hover:text-cream"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab content — each tab lazily loads its own agent status */}
          {activeTab === "surveyor" ? (
            <SurveyorTab
              config={agentConfig.surveyor}
              configuredKeys={configuredKeys}
              onSaved={onModelSaved}
            />
          ) : (
            <AgentModelTab
              agentId={activeTab}
              configuredKeys={configuredKeys}
              onSaved={onModelSaved}
            />
          )}
        </>
      )}
    </DashboardLayout>
  );
}

/* ------------------------------------------------------------------ */
/*  AgentModelTab                                                      */
/* ------------------------------------------------------------------ */

function AgentModelTab({
  agentId,
  configuredKeys,
  onSaved,
}: {
  agentId: string;
  configuredKeys: Set<string>;
  onSaved: () => void;
}) {
  // Lazy per-agent query — only runs 1 docker exec for the active tab
  const {
    data: agent,
    isLoading: agentLoading,
    refetch: refetchAgent,
  } = useQuery(getAgentConfig, { agentId });

  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // API key dialog state
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [pendingModel, setPendingModel] = useState<string | null>(null);

  // Reset message on tab change
  useEffect(() => {
    setMessage(null);
  }, [agentId]);

  const handleModelSelect = async (modelId: string) => {
    setMessage(null);

    // Check if the model is available with current credentials
    if (!isModelAvailable(modelId, configuredKeys)) {
      // Open the API key dialog
      setPendingModel(modelId);
      setKeyDialogOpen(true);
      return;
    }

    // Model is available, save directly
    setSaving(true);
    try {
      const result = await updateAgentModel({ agentId, model: modelId });
      setMessage(result?.message || "Model updated successfully");
      // Backend waits 1.5s for OpenClaw flush; delay refetch to avoid reading stale cache
      setTimeout(() => { refetchAgent(); onSaved(); }, 1000);
    } catch (e: any) {
      setMessage(e.message || "Failed to update model");
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDialogSaved = async () => {
    // Key was saved, now set the model
    if (!pendingModel) return;
    setSaving(true);
    setMessage(null);
    try {
      await updateAgentModel({ agentId, model: pendingModel });
      setMessage("API key saved and model updated");
      refetchAgent();
      onSaved();
    } catch (e: any) {
      setMessage(e.message || "Key saved but model update failed");
    } finally {
      setSaving(false);
      setPendingModel(null);
    }
  };

  // Compute dialog props from pending model
  const pendingProvider = pendingModel ? getRequiredProvider(pendingModel) : null;
  const pendingModelName = useMemo(() => {
    if (!pendingModel) return "";
    for (const group of MODEL_CATALOG) {
      for (const m of group.models) {
        if (m.id === pendingModel) return m.name;
      }
    }
    return pendingModel;
  }, [pendingModel]);
  const pendingProviderLabel = pendingProvider?.label || "OpenRouter";
  const pendingProviderEnvKey = pendingProvider?.envKey || null;

  if (agentLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-6">
          <Loader2 className="h-4 w-4 animate-spin text-gold" />
          <span className="text-muted-foreground text-sm">Loading model config...</span>
        </CardContent>
      </Card>
    );
  }

  if (!agent || agent.error) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-muted-foreground text-sm">
            {agent?.error || "Agent data not available. The OpenClaw container may not be running."}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardContent className="p-6">
          <CardTitle className="text-cream mb-1 text-base">{agent.label}</CardTitle>
          <p className="text-muted-foreground mb-4 text-sm">{agent.description}</p>

          {/* Model picker */}
          <div className="mb-4">
            <label className="text-muted-foreground mb-1 block text-xs uppercase tracking-wider">
              Default Model
            </label>
            <ModelSelect
              value={agent.defaultModel || ""}
              onSelect={handleModelSelect}
              configuredKeys={configuredKeys}
              placeholder="Select a model..."
            />
            {agent.resolvedDefault && agent.resolvedDefault !== agent.defaultModel && (
              <p className="text-muted-foreground mt-1 text-xs">
                Resolved: {agent.resolvedDefault}
              </p>
            )}
          </div>

          {/* Provider status */}
          {agent.providers && agent.providers.length > 0 && (
            <div className="mb-4">
              <label className="text-muted-foreground mb-2 block text-xs uppercase tracking-wider">
                Provider Auth
              </label>
              <div className="flex flex-wrap gap-2">
                {agent.providers.map((p: any) => (
                  <span
                    key={p.provider}
                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      p.effective
                        ? "bg-green-500/10 text-green-400"
                        : "bg-red-500/10 text-red-400"
                    }`}
                  >
                    {p.effective ? (
                      <CheckCircle className="h-3 w-3" />
                    ) : (
                      <XCircle className="h-3 w-3" />
                    )}
                    {p.provider}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Missing providers warning */}
          {agent.missingProviders && agent.missingProviders.length > 0 && (
            <div className="mb-4 flex items-start gap-2 rounded-sm border border-yellow-500/30 bg-yellow-500/5 px-3 py-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-yellow-500" />
              <div>
                <p className="text-sm text-yellow-400">
                  Missing provider{agent.missingProviders.length > 1 ? "s" : ""} for current model:
                </p>
                <p className="text-xs text-yellow-400/80">
                  {agent.missingProviders.join(", ")} — add the API key in Credentials
                </p>
              </div>
            </div>
          )}

          {/* Error from status fetch */}
          {agent.error && (
            <div className="mb-4 rounded-sm border border-red-500/30 bg-red-500/5 px-3 py-2">
              <p className="text-xs text-red-400">{agent.error}</p>
            </div>
          )}

          {/* Fallbacks */}
          {agent.fallbacks && agent.fallbacks.length > 0 && (
            <div className="mb-4">
              <label className="text-muted-foreground mb-1 block text-xs uppercase tracking-wider">
                Fallbacks
              </label>
              <p className="text-muted-foreground text-xs">
                {agent.fallbacks.join(" \u2192 ")}
              </p>
            </div>
          )}

          {/* Status messages */}
          {(message || saving) && (
            <div className="flex items-center gap-2">
              {saving && <Loader2 className="h-3 w-3 animate-spin text-gold" />}
              {message && (
                <p className={`text-xs ${message.includes("success") || message.includes("updated") ? "text-green-400" : "text-red-400"}`}>
                  {message}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* API Key Dialog */}
      <ApiKeyDialog
        open={keyDialogOpen}
        onOpenChange={(open) => {
          setKeyDialogOpen(open);
          if (!open) setPendingModel(null);
        }}
        modelName={pendingModelName}
        providerLabel={pendingProviderLabel}
        providerEnvKey={pendingProviderEnvKey}
        onSaved={handleKeyDialogSaved}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  SurveyorTab                                                        */
/* ------------------------------------------------------------------ */

function SurveyorTab({
  config,
  configuredKeys,
  onSaved,
}: {
  config: any;
  configuredKeys: Set<string>;
  onSaved: () => void;
}) {
  const [embedderModel, setEmbedderModel] = useState(config?.embedder_model || "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // API key dialog state for labeler
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [pendingLabelerModel, setPendingLabelerModel] = useState<string | null>(null);

  useEffect(() => {
    setEmbedderModel(config?.embedder_model || "");
    setMessage(null);
  }, [config?.embedder_model]);

  const embedderChanged = embedderModel !== (config?.embedder_model || "");

  const handleLabelerSelect = async (modelId: string) => {
    setMessage(null);

    if (!isModelAvailable(modelId, configuredKeys)) {
      setPendingLabelerModel(modelId);
      setKeyDialogOpen(true);
      return;
    }

    setSaving(true);
    try {
      await updateAgentModel({ agentId: "surveyor", model: modelId });
      setMessage("Labeler model updated");
      onSaved();
    } catch (e: any) {
      setMessage(e.message || "Failed to update");
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDialogSaved = async () => {
    if (!pendingLabelerModel) return;
    setSaving(true);
    setMessage(null);
    try {
      await updateAgentModel({ agentId: "surveyor", model: pendingLabelerModel });
      setMessage("API key saved and labeler model updated");
      onSaved();
    } catch (e: any) {
      setMessage(e.message || "Key saved but model update failed");
    } finally {
      setSaving(false);
      setPendingLabelerModel(null);
    }
  };

  const handleSaveEmbedder = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await updateAgentModel({ agentId: "surveyor", model: embedderModel, field: "embedder_model" });
      setMessage("Embedder model updated");
      onSaved();
    } catch (e: any) {
      setMessage(e.message || "Failed to update");
    } finally {
      setSaving(false);
    }
  };

  const pendingProvider = pendingLabelerModel ? getRequiredProvider(pendingLabelerModel) : null;
  const pendingModelName = useMemo(() => {
    if (!pendingLabelerModel) return "";
    for (const group of MODEL_CATALOG) {
      for (const m of group.models) {
        if (m.id === pendingLabelerModel) return m.name;
      }
    }
    return pendingLabelerModel;
  }, [pendingLabelerModel]);

  return (
    <>
      <Card>
        <CardContent className="p-6">
          <CardTitle className="text-cream mb-1 text-base">Surveyor</CardTitle>
          <p className="text-muted-foreground mb-4 text-sm">
            Surveyor is a Python pipeline (not an OpenClaw agent). It embeds vault records
            and clusters them for knowledge discovery.
          </p>

          <div className="space-y-4">
            <div>
              <label className="text-muted-foreground mb-1 block text-xs uppercase tracking-wider">
                Labeler Model
              </label>
              <ModelSelect
                value={config?.labeler_model || ""}
                onSelect={handleLabelerSelect}
                configuredKeys={configuredKeys}
                placeholder="Select a labeler model..."
              />
              <p className="text-muted-foreground mt-1 text-xs">
                OpenRouter model for cluster labeling and relationship discovery.
              </p>
            </div>

            <div>
              <label className="text-muted-foreground mb-1 block text-xs uppercase tracking-wider">
                Embedder Model
              </label>
              <div className="flex gap-2">
                <Input
                  value={embedderModel}
                  onChange={(e) => setEmbedderModel(e.target.value)}
                  placeholder="e.g. nomic-embed-text"
                  className="flex-1"
                />
                {embedderChanged && (
                  <Button onClick={handleSaveEmbedder} disabled={saving} size="sm">
                    <Save className="mr-1.5 h-3 w-3" />
                    {saving ? "..." : "Save"}
                  </Button>
                )}
              </div>
              <p className="text-muted-foreground mt-1 text-xs">
                Embedding model ({config?.embedder_source || "ollama"}).
                Changing this will re-embed all vault records.
              </p>
            </div>
          </div>

          {(message || saving) && (
            <div className="mt-4 flex items-center gap-2">
              {saving && <Loader2 className="h-3 w-3 animate-spin text-gold" />}
              {message && (
                <p className={`text-xs ${message.includes("updated") ? "text-green-400" : "text-red-400"}`}>
                  {message}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* API Key Dialog for labeler */}
      <ApiKeyDialog
        open={keyDialogOpen}
        onOpenChange={(open) => {
          setKeyDialogOpen(open);
          if (!open) setPendingLabelerModel(null);
        }}
        modelName={pendingModelName}
        providerLabel={pendingProvider?.label || "OpenRouter"}
        providerEnvKey={pendingProvider?.envKey || null}
        onSaved={handleKeyDialogSaved}
      />
    </>
  );
}
