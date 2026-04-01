import { useState, useEffect, useRef, useMemo } from "react";
import {
  useQuery,
  getDashboardData,
  getProvisioningStatus,
  getFirstBrief,
  getOnboardingProgress,
  startOnboarding,
  provisionNewUser,
  submitFactCorrections,
} from "wasp/client/operations";
import { useAuth } from "wasp/client/auth";
import { motion, AnimatePresence } from "framer-motion";
import DashboardLayout from "./DashboardLayout";
import VaultNebula from "../components/nebula/VaultNebula";

// ---------------------------------------------------------------------------
// Dashboard cache (preserved from original)
// ---------------------------------------------------------------------------

const DASHBOARD_CACHE_KEY = "alfred:dashboard:lastKnown";

function loadDashboardCache(): { data: any; cachedAt: number } | null {
  try {
    const raw = localStorage.getItem(DASHBOARD_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveDashboardCache(data: any): void {
  try {
    localStorage.setItem(
      DASHBOARD_CACHE_KEY,
      JSON.stringify({ data, cachedAt: Date.now() }),
    );
  } catch {}
}

// ---------------------------------------------------------------------------
// Onboarding state machine
// ---------------------------------------------------------------------------

type OnboardingState =
  | "new_user"               // State 1: No instance, need to provision
  | "provisioning"           // State 1: Provisioning in progress
  | "awaiting_brief"         // State 2: Instance ready, waiting for first brief
  | "awaiting_verification"  // State 2.5: Facts ready, verify before generating brief
  | "brief_ready"            // State 3: Brief is ready to show
  | "returning_user";        // State 4: Normal dashboard

// ---------------------------------------------------------------------------
// Cycling message hook
// ---------------------------------------------------------------------------

function useCyclingMessages(messages: string[], intervalMs: number = 4000): string {
  const [index, setIndex] = useState(0);
  const messagesRef = useRef(messages);

  useEffect(() => {
    messagesRef.current = messages;
    setIndex(0);
  }, [messages.join("|")]);

  useEffect(() => {
    if (messagesRef.current.length <= 1) return;
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % messagesRef.current.length);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, messages.length]);

  return messages[index] ?? "";
}

// ---------------------------------------------------------------------------
// Fact verification card component
// ---------------------------------------------------------------------------

function FactVerificationCard({
  facts,
  onConfirm,
}: {
  facts: Array<{ field: string; value: string; display: string }>;
  onConfirm: (corrections: Record<string, string>) => Promise<void>;
}) {
  const [editedFacts, setEditedFacts] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const f of facts) {
      initial[f.field] = f.value;
    }
    return initial;
  });
  const [editingField, setEditingField] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = async () => {
    setSubmitting(true);
    // Build corrections — only include fields that changed
    const corrections: Record<string, string> = {};
    for (const f of facts) {
      if (editedFacts[f.field] !== f.value) {
        corrections[f.display] = editedFacts[f.field];
      }
    }
    await onConfirm(corrections);
    setSubmitting(false);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.6 }}
      className="pointer-events-auto mt-8 w-full max-w-lg"
    >
      <p className="mb-6 font-serif text-sm font-light leading-relaxed text-[#E8E4DE]/80">
        Sir, before I share my first observations, I want to ensure I have the
        basics right. I've been studying your correspondence and believe the
        following to be true. Would you kindly correct anything I've got wrong?
      </p>

      <div className="space-y-2">
        {facts.map((fact) => (
          <div
            key={fact.field}
            className="flex items-center gap-3 rounded-sm border border-[#C9A84C]/10 bg-black/20 px-4 py-2.5"
          >
            <span className="w-24 flex-shrink-0 font-mono text-[0.55rem] uppercase tracking-wider text-[#C9A84C]/40">
              {fact.display}
            </span>
            {editingField === fact.field ? (
              <input
                type="text"
                autoFocus
                value={editedFacts[fact.field] || ""}
                onChange={(e) =>
                  setEditedFacts((prev) => ({ ...prev, [fact.field]: e.target.value }))
                }
                onBlur={() => setEditingField(null)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setEditingField(null);
                }}
                className="flex-1 bg-transparent font-serif text-sm text-[#E8E4DE] outline-none border-b border-[#C9A84C]/30 pb-0.5"
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditingField(fact.field)}
                className="flex-1 text-left font-serif text-sm text-[#E8E4DE] hover:text-[#C9A84C] transition-colors"
              >
                {editedFacts[fact.field] || "(unknown)"}
              </button>
            )}
            <span className="text-[0.6rem]">
              {editedFacts[fact.field] !== fact.value ? "✏️" : "✓"}
            </span>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={handleConfirm}
        disabled={submitting}
        className="mt-6 w-full rounded-sm border border-[#C9A84C]/30 bg-[#C9A84C]/10 px-6 py-3 font-mono text-xs uppercase tracking-[0.2em] text-[#C9A84C] transition-colors hover:bg-[#C9A84C]/20 disabled:opacity-50"
      >
        {submitting ? "Generating your brief..." : "That's correct, continue →"}
      </button>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Progress bar component
// ---------------------------------------------------------------------------

function GoldProgressBar({ active, progress }: { active: boolean; progress?: number }) {
  if (!active) return null;

  // If we have a real progress value (0-1), show a determinate bar
  if (progress != null && progress > 0 && progress < 1) {
    return (
      <div className="mt-6 h-[1px] w-48 overflow-hidden rounded-full bg-[#C9A84C]/10">
        <motion.div
          className="h-full bg-[#C9A84C]/60"
          initial={{ width: "0%" }}
          animate={{ width: `${Math.round(progress * 100)}%` }}
          transition={{ duration: 0.5, ease: "easeOut" }}
        />
      </div>
    );
  }

  return (
    <div className="mt-6 h-[1px] w-48 overflow-hidden rounded-full bg-[#C9A84C]/10">
      <motion.div
        className="h-full bg-[#C9A84C]/60"
        initial={{ x: "-100%" }}
        animate={{ x: "100%" }}
        transition={{
          repeat: Infinity,
          duration: 2,
          ease: "easeInOut",
        } as const}
        style={{ width: "40%" }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Brief display component
// ---------------------------------------------------------------------------

function BriefDisplay({ content, onContinue }: { content: string; onContinue: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 1.2, ease: "easeOut" as const }}
      className="pointer-events-auto mx-auto mt-8 max-w-[640px] max-h-[70vh] overflow-y-auto px-6 pb-24"
      style={{ scrollbarWidth: "thin", scrollbarColor: "#C9A84C33 transparent" }}
    >
      <div
        className="whitespace-pre-wrap text-left text-[#F0EDE8] leading-[1.8]"
        style={{ fontFamily: "'EB Garamond', 'Georgia', serif", fontSize: "1.1rem" }}
      >
        {content}
      </div>
      <div className="mt-12 flex justify-center">
        <button
          onClick={onContinue}
          className="rounded-full border border-[#C9A84C]/30 bg-[#C9A84C]/10 px-8 py-3 font-mono text-xs uppercase tracking-[0.2em] text-[#C9A84C] transition-all hover:bg-[#C9A84C]/20 hover:border-[#C9A84C]/50"
        >
          Continue to Dashboard
        </button>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Stage-specific message builder
// ---------------------------------------------------------------------------

function buildOnboardingMessage(stage: string, progress: any): string {
  const currentDay = progress?.current_day ?? 0;
  const totalDays = progress?.total_days ?? 0;
  const factsCount = progress?.facts_count ?? 0;

  switch (stage) {
    case "backfill":
      return "Reading your emails";
    case "processing":
      if (totalDays > 0) {
        return `Learning who you are (day ${currentDay} of ${totalDays})`;
      }
      return `Learning who you are (${factsCount} facts discovered)`;
    case "patterns":
      return "Finding patterns in your world";
    case "personalize":
      return "Personalizing your Alfred";
    case "automations":
      return "Thinking about how to help you";
    case "brief":
      return "Writing your first brief";
    case "done":
      return "Alfred is ready";
    default:
      return "Preparing your Alfred";
  }
}

// ---------------------------------------------------------------------------
// DashboardPage — zero-config onboarding + VaultNebula home
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const { data: authUser } = useAuth();

  // ---------------------------------------------------------------------------
  // Queries — conditionally poll based on state
  // ---------------------------------------------------------------------------

  const { data: provStatus } = useQuery(getProvisioningStatus, undefined, {
    refetchInterval: 5_000,
  });

  const { data: dashData, isLoading: dashLoading, error: dashError } = useQuery(
    getDashboardData,
    undefined,
    { refetchInterval: 30_000 },
  );

  const { data: briefData } = useQuery(getFirstBrief, undefined, {
    refetchInterval: 5_000,
  });

  const { data: onboardProgress } = useQuery(getOnboardingProgress, undefined, {
    refetchInterval: 5_000,
  });

  // ---------------------------------------------------------------------------
  // Dashboard cache (for returning users)
  // ---------------------------------------------------------------------------

  const [persistedCache, setPersistedCache] = useState<{
    data: any;
    cachedAt: number;
  } | null>(() => loadDashboardCache());

  useEffect(() => {
    if (dashData) {
      const cache = { data: dashData, cachedAt: Date.now() };
      setPersistedCache(cache);
      saveDashboardCache(dashData);
    }
  }, [dashData]);

  const displayData =
    dashData || (dashError && persistedCache ? persistedCache.data : null);

  // ---------------------------------------------------------------------------
  // State detection
  // ---------------------------------------------------------------------------

  const instanceStatus = provStatus?.instance?.status as string | undefined;
  const hasInstance = instanceStatus === "running";
  const isProvisioning =
    instanceStatus === "provisioning" ||
    provStatus?.job?.status === "running" ||
    provStatus?.job?.status === "pending";

  // Check for brief from onboard progress (v2) OR from vault event (v1 fallback)
  const onboardStage = onboardProgress?.stage as string | undefined;
  const onboardBrief = onboardProgress?.brief as string | undefined;
  const hasBrief =
    (onboardStage === "done" && onboardBrief != null && onboardBrief !== "") ||
    (briefData?.brief != null && briefData.brief !== "");

  const isNewUser = !hasInstance && !isProvisioning && provStatus !== undefined;

  // Onboarding is actively running if stage is not "done" and not "not_started"
  const isOnboardingActive =
    onboardStage != null &&
    onboardStage !== "done" &&
    onboardStage !== "not_started";

  // Persist brief dismissal so returning users don't see it again
  const [briefDismissed, setBriefDismissed] = useState(() => {
    return localStorage.getItem("alfred:brief_seen") === "true";
  });

  const onboardingState: OnboardingState = (() => {
    // Fact verification card — show before brief generation
    if (hasInstance && onboardStage === "awaiting_verification") {
      return "awaiting_verification";
    }
    // Brief ready and not yet dismissed — show it (highest priority)
    if (hasInstance && hasBrief && !briefDismissed && !isOnboardingActive) {
      return "brief_ready";
    }
    // Brief already seen/dismissed — normal dashboard
    if (hasInstance && briefDismissed && !isOnboardingActive) {
      return "returning_user";
    }
    // Instance running but onboarding still in progress or no brief yet
    if (hasInstance && (isOnboardingActive || !hasBrief)) {
      return "awaiting_brief";
    }
    // Provisioning in progress
    if (isProvisioning) {
      return "provisioning";
    }
    // New user — no instance
    if (isNewUser) {
      return "new_user";
    }
    // Still loading — treat as provisioning to show a nice message
    return "provisioning";
  })();

  const isOnboarding =
    onboardingState === "new_user" ||
    onboardingState === "provisioning" ||
    onboardingState === "awaiting_brief" ||
    onboardingState === "awaiting_verification" ||
    onboardingState === "brief_ready";

  // ---------------------------------------------------------------------------
  // Auto-trigger provisioning (State 1)
  // ---------------------------------------------------------------------------

  const provisioningTriggered = useRef(false);

  useEffect(() => {
    if (onboardingState !== "new_user") return;
    if (provisioningTriggered.current) return;
    provisioningTriggered.current = true;

    console.info("[DashboardPage] New user detected — triggering provisioning");
    provisionNewUser().catch((err: any) => {
      console.error("[DashboardPage] provisionNewUser failed:", err);
    });
  }, [onboardingState]);

  // ---------------------------------------------------------------------------
  // Auto-capture Google tokens + trigger onboarding after provisioning
  // ---------------------------------------------------------------------------

  const onboardingTriggered = useRef(false);

  useEffect(() => {
    if (onboardingState !== "awaiting_brief") return;
    if (onboardingTriggered.current) return;

    const hasCredential = provStatus?.hasGoogleCredential;

    // Clean up oauth=success from URL if present
    const params = new URLSearchParams(window.location.search);
    if (params.get("oauth") === "success") {
      window.history.replaceState({}, "", "/dashboard");
    }

    if (hasCredential) {
      // Credential exists — trigger onboarding workflow (creates Gmail stream + First Brief)
      onboardingTriggered.current = true;
      console.info("[DashboardPage] Google credential exists — triggering onboarding");
      startOnboarding({}).catch((err: any) => {
        console.error("[DashboardPage] onboarding workflow failed:", err);
      });
      return;
    }

    // No credential — redirect to capture tokens (one-time, Google auto-approves)
    if (!authUser?.id) return;
    onboardingTriggered.current = true;
    console.info("[DashboardPage] No Google credential — redirecting to OAuth");
    const scopes = "https://www.googleapis.com/auth/gmail.readonly";
    window.location.href = `/auth/oauth2/google/start?userId=${authUser.id}&scopes=${encodeURIComponent(scopes)}&redirectAfter=${encodeURIComponent("/dashboard?oauth=success")}`;
  }, [onboardingState, authUser, provStatus]);

  // ---------------------------------------------------------------------------
  // Brief auto-dismiss timer (30s)
  // ---------------------------------------------------------------------------

  // No auto-dismiss — user must click "Continue to Dashboard"
  const handleBriefContinue = () => {
    setBriefDismissed(true);
    localStorage.setItem("alfred:brief_seen", "true");
  };

  // ---------------------------------------------------------------------------
  // Stage-aware messages
  // ---------------------------------------------------------------------------

  const provisioningMessages = [
    "Alfred is waking up",
    "Provisioning your butler",
    "Setting up your space",
    "Almost there",
  ];

  // Build dynamic message from onboarding progress
  const onboardingMessage = useMemo(() => {
    if (onboardStage && isOnboardingActive) {
      return buildOnboardingMessage(onboardStage, onboardProgress?.progress);
    }
    return "Preparing your first brief";
  }, [onboardStage, onboardProgress?.progress, isOnboardingActive]);

  const activeMessages =
    onboardingState === "new_user" || onboardingState === "provisioning"
      ? provisioningMessages
      : onboardingState === "awaiting_brief"
        ? [onboardingMessage]
        : ["Alfred is ready"];

  const currentMessage = useCyclingMessages(activeMessages);

  // Calculate progress bar value for determinate progress
  const progressValue = useMemo(() => {
    if (!onboardProgress?.progress || !isOnboardingActive) return undefined;
    const { current_day, total_days } = onboardProgress.progress;
    if (onboardStage === "processing" && total_days > 0) {
      return current_day / total_days;
    }
    return undefined;
  }, [onboardProgress, onboardStage, isOnboardingActive]);

  // Use the brief from onboard progress if available, otherwise fall back to vault
  const briefContent = onboardBrief || briefData?.brief || "";

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // During onboarding, show fallback amber nebula (no vaultTypes)
  const nebulaTypes =
    isOnboarding ? null : (displayData?.vault?.types ?? null);

  return (
    <DashboardLayout hideSidebar={isOnboarding}>
      {/* VaultNebula — data-driven cloud background */}
      <VaultNebula vaultTypes={nebulaTypes} />

      {/* Onboarding states (1, 2, 3) */}
      {isOnboarding && (
        <div className="pointer-events-none fixed inset-0 z-10 flex flex-col items-center justify-center">
          {/* Cycling message */}
          <AnimatePresence mode="wait">
            <motion.p
              key={currentMessage}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.6, ease: "easeInOut" }}
              className="font-mono text-sm uppercase tracking-[0.25em] text-[#F0EDE8]/70"
            >
              {currentMessage}
            </motion.p>
          </AnimatePresence>

          {/* Fact counter — visible during processing stage */}
          {onboardStage === "processing" && onboardProgress?.progress?.facts_count > 0 && (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.6 }}
              className="mt-2 font-mono text-[0.6rem] uppercase tracking-[0.2em] text-[#C9A84C]/40"
            >
              {onboardProgress.progress.facts_count} facts discovered
            </motion.p>
          )}

          {/* Gold progress bar — visible during provisioning and brief generation */}
          <GoldProgressBar
            active={
              onboardingState === "new_user" ||
              onboardingState === "provisioning" ||
              onboardingState === "awaiting_brief"
            }
            progress={progressValue}
          />

          {/* Fact verification card (State 2.5) */}
          <AnimatePresence>
            {onboardingState === "awaiting_verification" && onboardProgress?.key_identity_facts?.length > 0 && (
              <FactVerificationCard
                facts={onboardProgress.key_identity_facts}
                onConfirm={async (corrections) => {
                  try {
                    await submitFactCorrections({ corrections });
                  } catch (err) {
                    console.error("Failed to submit corrections:", err);
                  }
                }}
              />
            )}
          </AnimatePresence>

          {/* Brief display (State 3) */}
          <AnimatePresence>
            {onboardingState === "brief_ready" && briefContent && (
              <BriefDisplay content={briefContent} onContinue={handleBriefContinue} />
            )}
          </AnimatePresence>

          {/* Bottom breathing indicator for brief_ready state */}
          {onboardingState === "brief_ready" && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 2, duration: 1 }}
              className="absolute bottom-8"
            >
              <span
                className="font-mono text-[0.55rem] uppercase tracking-[0.25em] text-[#C9A84C]/50"
                style={{ animation: "breathe 4s ease-in-out infinite" }}
              >
                Alfred is watching
              </span>
            </motion.div>
          )}
        </div>
      )}

      {/* State 4: Returning user — normal dashboard */}
      {!isOnboarding && (
        <div className="pointer-events-none fixed inset-0 z-10 flex flex-col items-center justify-end pb-8">
          {dashLoading && !displayData && (
            <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-[#C9A84C]/20 bg-black/60 px-4 py-3 backdrop-blur-sm">
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 1, ease: "linear" } as const}
                className="h-4 w-4 border-2 border-[#C9A84C] border-t-transparent rounded-full"
              />
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-[#F0EDE8]/60">
                Loading vault topology...
              </p>
            </div>
          )}

          {dashError && !displayData && (
            <div className="pointer-events-auto rounded-xl border border-destructive/30 bg-black/60 p-4 text-destructive backdrop-blur-sm">
              <p className="font-sans text-sm font-light">
                Tenant unreachable — showing empty nebula.
              </p>
            </div>
          )}

          {/* Record count badge */}
          {displayData?.vault?.total_records != null && (
            <div className="pointer-events-auto mt-4 rounded-full border border-[#C9A84C]/15 bg-black/40 px-4 py-1.5 backdrop-blur-sm">
              <span className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-[#F0EDE8]/40">
                {displayData.vault.total_records} records
              </span>
            </div>
          )}

          {/* Breathing indicator — Alfred is alive */}
          <div className="mt-3">
            <span
              className="font-mono text-[0.55rem] uppercase tracking-[0.25em] text-[#C9A84C]/50"
              style={{ animation: "breathe 4s ease-in-out infinite" }}
            >
              Alfred is watching
            </span>
          </div>
        </div>
      )}

      {/* Shared breathe keyframes */}
      <style>{`
        @keyframes breathe {
          0%, 100% { opacity: 0.15; }
          50% { opacity: 0.6; }
        }
      `}</style>
    </DashboardLayout>
  );
}
