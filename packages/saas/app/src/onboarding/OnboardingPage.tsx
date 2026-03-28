import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "wasp/client/auth";
import {
  useQuery,
  getStreams,
  updateWorkspaceFile,
  startOnboarding,
  getFirstBrief,
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
  Radio,
  LayoutDashboard,
  FileText,
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
      setUserForm((prev) => ({ ...prev, email: user.email ?? "" }));
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
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const handleBack = () => {
    setStep((s) => Math.max(s - 1, 0));
  };

  const handleConnectGmail = () => {
    if (!user) return;
    const scopes = "https://www.googleapis.com/auth/gmail.readonly";
    const redirectAfter = encodeURIComponent("/onboarding?step=3");
    window.location.href = `/auth/oauth2/google/start?userId=${user.id}&scopes=${scopes}&redirectAfter=${redirectAfter}`;
  };

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
          <StepConnect
            gmailConnected={gmailConnected}
            onConnectGmail={handleConnectGmail}
            onNext={handleNext}
            onBack={handleBack}
          />
        )}
        {step === 4 && (
          <StepDone
            userName={userForm.fullName}
            presetLabel={SOUL_PRESETS[soulPreset].label}
            gmailConnected={gmailConnected}
            onFinish={() => navigate("/dashboard")}
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
            onChange={(e) => update("fullName", e.target.value)}
            placeholder="Jane Smith"
            className={inputClass}
          />
        </Field>

        <Field label="Email">
          <input
            type="email"
            value={form.email}
            onChange={(e) => update("email", e.target.value)}
            placeholder="jane@example.com"
            className={inputClass}
          />
        </Field>

        <Field label="Location / Timezone">
          <input
            type="text"
            value={form.location}
            onChange={(e) => update("location", e.target.value)}
            placeholder="San Francisco, CA (Pacific Time)"
            className={inputClass}
          />
        </Field>

        <Field label="What you do">
          <textarea
            value={form.whatYouDo}
            onChange={(e) => update("whatYouDo", e.target.value)}
            placeholder="2-3 sentences about your work, role, or what you spend your days on."
            rows={3}
            className={inputClass}
          />
        </Field>

        <Field label="Your priorities">
          <textarea
            value={form.priorities}
            onChange={(e) => update("priorities", e.target.value)}
            placeholder="What matters most to you right now? Projects, goals, themes."
            rows={3}
            className={inputClass}
          />
        </Field>

        <Field label="Family / Household" optional>
          <textarea
            value={form.household}
            onChange={(e) => update("household", e.target.value)}
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
          onChange={(e) => onCustomChange(e.target.value)}
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

function StepConnect({
  gmailConnected,
  onConnectGmail,
  onNext,
  onBack,
}: {
  gmailConnected: boolean;
  onConnectGmail: () => void;
  onNext: () => void;
  onBack: () => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Radio className="h-5 w-5 text-gold" />
        <h2 className="font-serif text-2xl font-light text-cream">
          Connect your data sources
        </h2>
      </div>

      <p className="text-[#8A8680] text-sm mb-6">
        Alfred works best when it can see your world. Connect services to let Alfred
        monitor and act on your behalf.
      </p>

      <div
        className={cn(
          "rounded-sm border p-4 flex items-center justify-between",
          gmailConnected
            ? "border-green-500/40 bg-green-500/5"
            : "border-[#333] bg-[#111]",
        )}
      >
        <div className="flex items-center gap-3">
          <Mail className="h-5 w-5 text-[#8A8680]" />
          <div>
            <p className="text-sm font-medium text-cream">Gmail</p>
            <p className="text-xs text-[#8A8680]">
              Monitor your inbox for important emails
            </p>
          </div>
        </div>
        {gmailConnected ? (
          <span className="flex items-center gap-1.5 text-xs text-green-400 font-mono uppercase tracking-wider">
            <Check className="h-3.5 w-3.5" />
            Connected
          </span>
        ) : (
          <Button variant="outline" size="sm" onClick={onConnectGmail}>
            Connect
          </Button>
        )}
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
        <Button onClick={onNext}>
          {gmailConnected ? "Next" : "Skip for now"}
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
  const [briefState, setBriefState] = useState<
    "idle" | "starting" | "generating" | "ready" | "error"
  >("idle");
  const [briefError, setBriefError] = useState<string | null>(null);

  const handleGenerateBrief = async () => {
    setBriefState("starting");
    setBriefError(null);
    try {
      await startOnboarding({});
      setBriefState("generating");
    } catch (e: any) {
      console.error("Failed to start onboarding workflow:", e);
      setBriefError(e?.message || "Failed to start onboarding workflow");
      setBriefState("error");
    }
  };

  const handleBriefReady = useCallback(() => {
    setBriefState("ready");
  }, []);

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

      {/* First Brief Generation */}
      {briefState === "idle" && (
        <div className="mb-8">
          <Button onClick={handleGenerateBrief} variant="outline" size="lg">
            <FileText className="mr-2 h-4 w-4" />
            Generate Your First Brief
          </Button>
          <p className="mt-3 text-xs text-[#8A8680]">
            Alfred will read your connected data and prepare a personalized summary.
          </p>
        </div>
      )}

      {briefState === "starting" && (
        <div className="mb-8 rounded-sm border border-[#333] bg-[#111] p-6">
          <div className="flex items-center justify-center gap-3">
            <Loader2 className="h-4 w-4 animate-spin text-gold" />
            <p className="font-sans text-sm text-cream/70">
              Starting onboarding workflow...
            </p>
          </div>
        </div>
      )}

      {briefState === "generating" && (
        <div className="mb-8">
          <FirstBriefInline onBriefReady={handleBriefReady} />
        </div>
      )}

      {briefState === "ready" && (
        <div className="mb-8">
          <FirstBriefInline onBriefReady={handleBriefReady} />
        </div>
      )}

      {briefState === "error" && (
        <div className="mb-8">
          <div className="rounded-sm border border-destructive/30 bg-destructive/10 p-4 mb-4">
            <p className="font-sans text-sm text-destructive">
              {briefError || "Something went wrong."}
            </p>
          </div>
          <Button onClick={handleGenerateBrief} variant="outline" size="sm">
            Try Again
          </Button>
        </div>
      )}

      <Button onClick={onFinish} size="lg">
        <LayoutDashboard className="mr-2 h-4 w-4" />
        Go to Dashboard
      </Button>
    </div>
  );
}

/**
 * Inline brief display for the onboarding completion page.
 * Polls for the brief and shows it when ready.
 */
function FirstBriefInline({ onBriefReady }: { onBriefReady: () => void }) {
  const [notified, setNotified] = useState(false);
  const { data } = useQuery(getFirstBrief, undefined, {
    refetchInterval: 5_000,
  });

  const brief = data?.brief ?? null;

  // Notify parent once when brief arrives
  if (brief && !notified) {
    setNotified(true);
    setTimeout(() => onBriefReady(), 0);
  }

  if (!brief) {
    return (
      <div className="rounded-sm border border-[#333] bg-[#111] p-6">
        <div className="flex items-center justify-center gap-3 mb-2">
          <div className="relative flex h-5 w-5 items-center justify-center">
            <div className="absolute h-5 w-5 animate-ping rounded-full bg-gold/20" />
            <div className="h-2.5 w-2.5 rounded-full bg-gold/60" />
          </div>
          <p className="font-sans text-sm text-cream/70">
            Alfred is reading your emails and preparing your personalized brief.
          </p>
        </div>
        <p className="font-mono text-[0.6rem] text-muted-foreground/50">
          This takes about 2 minutes.
        </p>
      </div>
    );
  }

  // Render the brief text with basic formatting
  const paragraphs = brief.split(/\n{2,}/);
  return (
    <div className="rounded-sm border border-gold/20 bg-gold/5 p-6 text-left">
      <div className="flex items-center gap-2 mb-4">
        <FileText className="h-4 w-4 text-gold" />
        <span className="font-serif text-base font-light text-cream">
          Your First Brief
        </span>
      </div>
      <div className="space-y-3">
        {paragraphs.map((p: string, i: number) => (
          <p
            key={i}
            className="font-sans text-sm font-light leading-relaxed text-cream/80"
            dangerouslySetInnerHTML={{
              __html: p
                .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
                .replace(/\*(.+?)\*/g, "<em>$1</em>")
                .replace(/\n/g, "<br />"),
            }}
          />
        ))}
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
