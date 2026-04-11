import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "wasp/client/auth";
import {
  useQuery,
  getStreams,
  getConnectedIntegrations,
  getIntegrationCatalog,
  initiateConnect,
  updateWorkspaceFile,
} from "wasp/client/operations";
import { Button } from "../client/components/ui/button";
import { cn } from "../client/utils";
import {
  ArrowRight,
  ArrowLeft,
  Check,
  Loader2,
  Mail,
  User,
  Sparkles,
  FileText,
  Calendar,
  Puzzle,
  Search,
  ExternalLink,
  X,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UserFormData {
  fullName: string;
  email: string;
  location: string;
  whatYouDo: string;
  priorities: string;
  household: string;
}

type SoulPreset = "butler" | "friendly" | "silent";

const SOUL_PRESETS: Record<
  SoulPreset,
  { label: string; description: string; content: string }
> = {
  butler: {
    label: "Professional Butler",
    description: "Formal, concise, proactive. Anticipates needs before you ask.",
    content: `# SOUL.md

## Personality
Alfred operates as a formal, composed professional butler. Communication is concise and precise. No unnecessary pleasantries — every message has a purpose.

## Principles
- Anticipate needs before they are expressed
- Present information in structured, scannable formats
- Default to action over asking for permission on routine matters
- Escalate only when the stakes warrant it
- Maintain discretion at all times

## Tone
Formal but not stiff. Think Jeeves, not a chatbot. Use "Sir" or "Ma'am" sparingly — only when it adds gravity.
`,
  },
  friendly: {
    label: "Friendly Assistant",
    description: "Casual, warm, asks clarifying questions. Like a helpful colleague.",
    content: `# SOUL.md

## Personality
Alfred is a warm, approachable assistant who communicates casually and clearly. Asks questions when unsure rather than guessing. Uses a conversational tone.

## Principles
- Ask clarifying questions rather than making assumptions
- Explain reasoning when making suggestions
- Celebrate wins and acknowledge effort
- Be honest about limitations
- Keep things light but substantive

## Tone
Friendly and conversational. Like texting a sharp friend who happens to be incredibly organized. Emojis welcome but not overdone.
`,
  },
  silent: {
    label: "Silent Operator",
    description: "Minimal output, just gets things done. Speaks only when necessary.",
    content: `# SOUL.md

## Personality
Alfred is a silent operator. Minimal communication — results speak. Only surfaces information when action is required or something is urgent.

## Principles
- Do, don't discuss
- Only notify when human input is required
- Compress information ruthlessly
- No status updates unless asked
- When reporting, use bullet points and data — no prose

## Tone
Terse. Functional. Like a well-configured CI pipeline — you only hear from it when something needs attention.
`,
  },
};

const STEPS = ["Welcome", "About You", "Alfred's Style", "Connect Data", "Done"];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function OnboardingPage() {
  const navigate = useNavigate();
  const { data: user } = useAuth();
  const { data: streams } = useQuery(getStreams);

  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);

  // Step 2: User form
  const [userForm, setUserForm] = useState<UserFormData>({
    fullName: "",
    email: user?.email ?? "",
    location: "",
    whatYouDo: "",
    priorities: "",
    household: "",
  });

  // Step 3: Soul preset
  const [soulPreset, setSoulPreset] = useState<SoulPreset>("butler");
  const [customInstructions, setCustomInstructions] = useState("");

  // Pre-fill email when user loads
  useState(() => {
    if (user?.email && !userForm.email) {
      setUserForm((prev: typeof userForm) => ({ ...prev, email: user.email ?? "" }));
    }
  });

  const gmailConnected = Array.isArray(streams)
    ? streams.some((s: any) => s.source === "gmail")
    : false;

  // ---------------------------------------------------------------------------
  // Save handlers
  // ---------------------------------------------------------------------------

  const saveUserMd = async () => {
    const lines: string[] = ["# USER.md", ""];
    if (userForm.fullName) {
      lines.push(`## Name`, userForm.fullName, "");
    }
    if (userForm.email) {
      lines.push(`## Email`, userForm.email, "");
    }
    if (userForm.location) {
      lines.push(`## Location / Timezone`, userForm.location, "");
    }
    if (userForm.whatYouDo) {
      lines.push(`## What I Do`, userForm.whatYouDo, "");
    }
    if (userForm.priorities) {
      lines.push(`## Priorities`, userForm.priorities, "");
    }
    if (userForm.household) {
      lines.push(`## Household`, userForm.household, "");
    }

    await updateWorkspaceFile({
      filename: "USER.md",
      content: lines.join("\n"),
    });
  };

  const saveSoulMd = async () => {
    let content = SOUL_PRESETS[soulPreset].content;
    if (customInstructions.trim()) {
      content += `\n## Custom Instructions\n${customInstructions.trim()}\n`;
    }
    await updateWorkspaceFile({
      filename: "SOUL.md",
      content,
    });
  };

  const handleNext = async () => {
    // Save on step transitions that require it
    if (step === 1) {
      setSaving(true);
      try {
        await saveUserMd();
      } catch (e) {
        console.error("Failed to save USER.md:", e);
      } finally {
        setSaving(false);
      }
    }
    if (step === 2) {
      setSaving(true);
      try {
        await saveSoulMd();
      } catch (e) {
        console.error("Failed to save SOUL.md:", e);
      } finally {
        setSaving(false);
      }
    }
    setStep((s: number) => Math.min(s + 1, STEPS.length - 1));
  };

  const handleBack = () => {
    setStep((s: number) => Math.max(s - 1, 0));
  };

  // Legacy handleConnectGmail removed — Gmail now connects via Composio popup in StepConnectApps

  // Restore step from URL param (OAuth redirect back)
  useState(() => {
    const params = new URLSearchParams(window.location.search);
    const stepParam = params.get("step");
    if (stepParam) {
      const n = parseInt(stepParam, 10);
      if (!isNaN(n) && n >= 0 && n < STEPS.length) {
        setStep(n);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#0A0A0A] p-4">
      {/* Progress indicator */}
      <div className="mb-8 flex items-center gap-2">
        {STEPS.map((label, i) => (
          <div key={label} className="flex items-center gap-2">
            <div
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full text-xs font-mono transition-colors",
                i < step
                  ? "bg-gold text-[#0A0A0A]"
                  : i === step
                    ? "border-2 border-gold text-gold"
                    : "border border-[#333] text-[#555]",
              )}
            >
              {i < step ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={cn(
                  "h-px w-8 transition-colors",
                  i < step ? "bg-gold" : "bg-[#333]",
                )}
              />
            )}
          </div>
        ))}
      </div>

      {/* Step content */}
      <div className="w-full max-w-lg">
        {step === 0 && <StepWelcome onNext={handleNext} />}
        {step === 1 && (
          <StepUser
            form={userForm}
            onChange={setUserForm}
            onNext={handleNext}
            onBack={handleBack}
            saving={saving}
          />
        )}
        {step === 2 && (
          <StepSoul
            preset={soulPreset}
            onPresetChange={setSoulPreset}
            customInstructions={customInstructions}
            onCustomChange={setCustomInstructions}
            onNext={handleNext}
            onBack={handleBack}
            saving={saving}
          />
        )}
        {step === 3 && (
          <StepConnectApps
            legacyGmailConnected={gmailConnected}
            onNext={handleNext}
            onBack={handleBack}
          />
        )}
        {step === 4 && (
          <StepDone
            userName={userForm.fullName}
            presetLabel={SOUL_PRESETS[soulPreset].label}
            gmailConnected={gmailConnected}
            onFinish={() => navigate("/onboarding/orb")}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step Components
// ---------------------------------------------------------------------------

function StepWelcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="text-center">
      <h1 className="font-serif text-4xl font-light text-cream mb-4">
        Welcome to Alfred
      </h1>
      <p className="text-[#8A8680] text-base leading-relaxed mb-8 max-w-md mx-auto">
        Let's set up Alfred to know you. This takes about 2 minutes.
      </p>
      <Button onClick={onNext} size="lg">
        Get Started
        <ArrowRight className="ml-2 h-4 w-4" />
      </Button>
    </div>
  );
}

function StepUser({
  form,
  onChange,
  onNext,
  onBack,
  saving,
}: {
  form: UserFormData;
  onChange: (f: UserFormData) => void;
  onNext: () => void;
  onBack: () => void;
  saving: boolean;
}) {
  const update = (field: keyof UserFormData, value: string) =>
    onChange({ ...form, [field]: value });

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <User className="h-5 w-5 text-gold" />
        <h2 className="font-serif text-2xl font-light text-cream">
          Tell Alfred about yourself
        </h2>
      </div>

      <div className="space-y-4">
        <Field label="Full name" required>
          <input
            type="text"
            value={form.fullName}
            onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => update("fullName", e.target.value)}
            placeholder="Jane Smith"
            className={inputClass}
          />
        </Field>

        <Field label="Email">
          <input
            type="email"
            value={form.email}
            onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => update("email", e.target.value)}
            placeholder="jane@example.com"
            className={inputClass}
          />
        </Field>

        <Field label="Location / Timezone">
          <input
            type="text"
            value={form.location}
            onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => update("location", e.target.value)}
            placeholder="San Francisco, CA (Pacific Time)"
            className={inputClass}
          />
        </Field>

        <Field label="What you do">
          <textarea
            value={form.whatYouDo}
            onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => update("whatYouDo", e.target.value)}
            placeholder="2-3 sentences about your work, role, or what you spend your days on."
            rows={3}
            className={inputClass}
          />
        </Field>

        <Field label="Your priorities">
          <textarea
            value={form.priorities}
            onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => update("priorities", e.target.value)}
            placeholder="What matters most to you right now? Projects, goals, themes."
            rows={3}
            className={inputClass}
          />
        </Field>

        <Field label="Family / Household" optional>
          <textarea
            value={form.household}
            onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => update("household", e.target.value)}
            placeholder="Who lives with you, pets, anything Alfred should know about your household."
            rows={2}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="mt-8 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-[#8A8680] hover:text-cream transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </button>
        <Button onClick={onNext} disabled={!form.fullName.trim() || saving}>
          {saving ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : null}
          {saving ? "Saving..." : "Next"}
          {!saving && <ArrowRight className="ml-2 h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}

function StepSoul({
  preset,
  onPresetChange,
  customInstructions,
  onCustomChange,
  onNext,
  onBack,
  saving,
}: {
  preset: SoulPreset;
  onPresetChange: (p: SoulPreset) => void;
  customInstructions: string;
  onCustomChange: (s: string) => void;
  onNext: () => void;
  onBack: () => void;
  saving: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Sparkles className="h-5 w-5 text-gold" />
        <h2 className="font-serif text-2xl font-light text-cream">
          How should Alfred behave?
        </h2>
      </div>

      <div className="space-y-3">
        {(Object.entries(SOUL_PRESETS) as [SoulPreset, typeof SOUL_PRESETS[SoulPreset]][]).map(
          ([key, { label, description }]) => (
            <button
              key={key}
              type="button"
              onClick={() => onPresetChange(key)}
              className={cn(
                "w-full rounded-sm border p-4 text-left transition-colors",
                preset === key
                  ? "border-gold bg-gold/5"
                  : "border-[#333] bg-[#111] hover:border-[#555]",
              )}
            >
              <div className="flex items-center gap-3">
                <div
                  className={cn(
                    "flex h-4 w-4 items-center justify-center rounded-full border-2",
                    preset === key ? "border-gold" : "border-[#555]",
                  )}
                >
                  {preset === key && (
                    <div className="h-2 w-2 rounded-full bg-gold" />
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium text-cream">{label}</p>
                  <p className="text-xs text-[#8A8680] mt-0.5">{description}</p>
                </div>
              </div>
            </button>
          ),
        )}
      </div>

      <div className="mt-6">
        <label className="block text-xs font-mono uppercase tracking-wider text-[#8A8680] mb-2">
          Custom instructions (optional)
        </label>
        <textarea
          value={customInstructions}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onCustomChange(e.target.value)}
          placeholder="Any additional instructions for Alfred's behavior..."
          rows={3}
          className={inputClass}
        />
      </div>

      <div className="mt-8 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-[#8A8680] hover:text-cream transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </button>
        <Button onClick={onNext} disabled={saving}>
          {saving ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : null}
          {saving ? "Saving..." : "Next"}
          {!saving && <ArrowRight className="ml-2 h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}

function StepConnectApps({
  legacyGmailConnected,
  onNext,
  onBack,
}: {
  legacyGmailConnected: boolean;
  onNext: () => void;
  onBack: () => void;
}) {
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectedApps, setConnectedApps] = useState<Record<string, boolean>>({});
  const [showCatalog, setShowCatalog] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [extraApp, setExtraApp] = useState<{ slug: string; name: string } | null>(null);

  const { data: connectedData, refetch: refetchConnected } = useQuery(getConnectedIntegrations);
  const { data: catalogData } = useQuery(getIntegrationCatalog, { search: "", category: "" });

  // Track which toolkits are connected via Composio
  const composioConnected = new Set(
    (connectedData?.integrations || [])
      .filter((c: any) => c.status === "ACTIVE")
      .map((c: any) => c.toolkit),
  );

  const isGmailConnected = legacyGmailConnected || composioConnected.has("gmail") || connectedApps.gmail;
  const isCalendarConnected = composioConnected.has("googlecalendar") || connectedApps.googlecalendar;
  const isExtraConnected = extraApp ? (composioConnected.has(extraApp.slug) || connectedApps[extraApp.slug]) : false;

  const handleComposioConnect = async (toolkitSlug: string) => {
    setConnecting(toolkitSlug);
    try {
      const result = await initiateConnect({
        toolkit_slug: toolkitSlug,
        redirect_url: `${window.location.origin}/onboarding?step=3&composio_callback=success&toolkit=${toolkitSlug}`,
      });
      const connectUrl = result?.connect_url;
      if (connectUrl) {
        const popup = window.open(connectUrl, "composio-connect", "width=600,height=700,left=200,top=100");
        if (popup) {
          const interval = setInterval(() => {
            if (popup.closed) {
              clearInterval(interval);
              setConnecting(null);
              setConnectedApps((prev) => ({ ...prev, [toolkitSlug]: true }));
              refetchConnected();
            }
          }, 500);
          setTimeout(() => { clearInterval(interval); setConnecting(null); }, 120000);
        }
      } else {
        setConnecting(null);
      }
    } catch {
      setConnecting(null);
    }
  };

  // Filter catalog for the "Add another app" picker
  const catalogApps = (catalogData?.toolkits || []).filter((t: any) => {
    if (["gmail", "googlecalendar"].includes(t.slug)) return false; // already shown
    if (composioConnected.has(t.slug)) return false;
    if (!catalogSearch) return true;
    const s = catalogSearch.toLowerCase();
    return t.name.toLowerCase().includes(s) || t.slug.toLowerCase().includes(s);
  });

  const ConnectRow = ({
    icon,
    name,
    description,
    connected,
    connecting: isConnecting,
    onConnect,
    required,
  }: {
    icon: React.ReactNode;
    name: string;
    description: string;
    connected: boolean;
    connecting: boolean;
    onConnect: () => void;
    required?: boolean;
  }) => (
    <div
      className={cn(
        "rounded-lg border p-4 flex items-center justify-between transition-colors",
        connected ? "border-emerald-500/30 bg-emerald-500/5" : "border-[#333] bg-[#111]",
      )}
    >
      <div className="flex items-center gap-3">
        {icon}
        <div>
          <p className="text-sm font-medium text-[#F0EDE8]">
            {name} {required && <span className="text-[0.6rem] text-[#C9A84C]">(required)</span>}
          </p>
          <p className="text-xs text-[#8A8680]">{description}</p>
        </div>
      </div>
      {connected ? (
        <span className="flex items-center gap-1.5 text-xs text-emerald-400 font-mono uppercase tracking-wider">
          <Check className="h-3.5 w-3.5" /> Connected
        </span>
      ) : (
        <Button variant="outline" size="sm" onClick={onConnect} disabled={isConnecting}>
          {isConnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5 mr-1.5" />}
          {isConnecting ? "Connecting..." : "Connect"}
        </Button>
      )}
    </div>
  );

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Puzzle className="h-5 w-5 text-[#C9A84C]" />
        <h2 className="font-serif text-2xl font-light text-[#F0EDE8]">
          Connect your apps
        </h2>
      </div>

      <p className="text-[#8A8680] text-sm mb-6">
        Alfred works best with access to your world. Connect at least Gmail to get started.
        All connections are managed securely — your credentials never touch the server.
      </p>

      <div className="space-y-3">
        <ConnectRow
          icon={<Mail className="h-5 w-5 text-[#8A8680]" />}
          name="Gmail"
          description="Email monitoring and actions"
          connected={isGmailConnected}
          connecting={connecting === "gmail"}
          onConnect={() => handleComposioConnect("gmail")}
          required
        />

        <ConnectRow
          icon={<Calendar className="h-5 w-5 text-[#8A8680]" />}
          name="Google Calendar"
          description="Calendar events and scheduling"
          connected={isCalendarConnected}
          connecting={connecting === "googlecalendar"}
          onConnect={() => handleComposioConnect("googlecalendar")}
        />

        {extraApp ? (
          <ConnectRow
            icon={<Puzzle className="h-5 w-5 text-[#8A8680]" />}
            name={extraApp.name}
            description={`Connected via Composio`}
            connected={isExtraConnected}
            connecting={connecting === extraApp.slug}
            onConnect={() => handleComposioConnect(extraApp.slug)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowCatalog(true)}
            className="w-full rounded-lg border border-dashed border-[#333] p-4 flex items-center gap-3 text-left hover:border-[#C9A84C]/30 transition-colors"
          >
            <Puzzle className="h-5 w-5 text-[#8A8680]" />
            <div>
              <p className="text-sm font-medium text-[#8A8680]">Add another app</p>
              <p className="text-xs text-[#8A8680]/60">Notion, GitHub, Slack, Linear, and 1000+ more</p>
            </div>
          </button>
        )}
      </div>

      {/* Mini catalog modal */}
      {showCatalog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md rounded-xl border border-[#333] bg-[#111] p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-[#F0EDE8]">Choose an app</h3>
              <button onClick={() => setShowCatalog(false)} className="text-[#8A8680] hover:text-[#F0EDE8]">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8A8680]" />
              <input
                type="text"
                placeholder="Search apps..."
                value={catalogSearch}
                onChange={(e) => setCatalogSearch(e.target.value)}
                className="w-full rounded-lg border border-[#333] bg-black/50 py-2 pl-9 pr-3 text-sm text-[#F0EDE8] placeholder-[#8A8680]/60 outline-none focus:border-[#C9A84C]/30"
                autoFocus
              />
            </div>
            <div className="max-h-60 overflow-y-auto space-y-1">
              {catalogApps.slice(0, 20).map((app: any) => (
                <button
                  key={app.slug}
                  onClick={() => {
                    setExtraApp({ slug: app.slug, name: app.name });
                    setShowCatalog(false);
                    setCatalogSearch("");
                    handleComposioConnect(app.slug);
                  }}
                  className="w-full rounded-lg px-3 py-2 text-left hover:bg-white/[0.04] transition-colors"
                >
                  <span className="text-sm text-[#F0EDE8]">{app.name}</span>
                  {app.category && (
                    <span className="ml-2 text-[0.6rem] text-[#8A8680]">{app.category}</span>
                  )}
                </button>
              ))}
              {catalogApps.length === 0 && (
                <p className="text-center text-xs text-[#8A8680] py-4">No apps found</p>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="mt-8 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-[#8A8680] hover:text-[#F0EDE8] transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </button>
        <Button onClick={onNext} disabled={!isGmailConnected}>
          {isGmailConnected ? "Next" : "Connect Gmail to continue"}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function StepDone({
  userName,
  presetLabel,
  gmailConnected,
  onFinish,
}: {
  userName: string;
  presetLabel: string;
  gmailConnected: boolean;
  onFinish: () => void;
}) {
  return (
    <div className="text-center">
      <h1 className="font-serif text-4xl font-light text-cream mb-4">
        Alfred is ready
      </h1>
      <p className="text-[#8A8680] text-base mb-8">
        Here's what we configured:
      </p>

      <div className="rounded-sm border border-[#333] bg-[#111] p-6 text-left space-y-3 mb-8">
        <SummaryRow
          icon={<User className="h-4 w-4" />}
          label="Identity"
          value={userName || "Set"}
        />
        <SummaryRow
          icon={<Sparkles className="h-4 w-4" />}
          label="Style"
          value={presetLabel}
        />
        <SummaryRow
          icon={<Mail className="h-4 w-4" />}
          label="Gmail"
          value={gmailConnected ? "Connected" : "Skipped"}
        />
      </div>

      <div className="mb-8">
        <Button onClick={onFinish} variant="outline" size="lg">
          <FileText className="mr-2 h-4 w-4" />
          Generate Your First Brief
        </Button>
        <p className="mt-3 text-xs text-[#8A8680]">
          Alfred will read your connected data and prepare a personalized summary.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared UI
// ---------------------------------------------------------------------------

function Field({
  label,
  required,
  optional,
  children,
}: {
  label: string;
  required?: boolean;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-mono uppercase tracking-wider text-[#8A8680] mb-1.5">
        {label}
        {required && <span className="text-gold ml-1">*</span>}
        {optional && (
          <span className="ml-2 text-[#555] normal-case tracking-normal">
            optional
          </span>
        )}
      </label>
      {children}
    </div>
  );
}

function SummaryRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-gold">{icon}</span>
      <span className="text-[#8A8680] w-20">{label}</span>
      <span className="text-cream">{value}</span>
    </div>
  );
}

const inputClass = cn(
  "w-full rounded-sm border border-[#333] bg-[#111] px-3 py-2 text-sm text-cream",
  "placeholder:text-[#555] focus:outline-none focus:ring-1 focus:ring-gold/50 focus:border-gold/50",
  "resize-none",
);
