import { useState, useEffect, useRef } from "react";
import {
  useQuery,
  getDashboardData,
  getProvisioningStatus,
  getFirstBrief,
  startOnboarding,
  provisionNewUser,
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
  | "new_user"        // State 1: No instance, need to provision
  | "provisioning"    // State 1: Provisioning in progress
  | "awaiting_brief"  // State 2: Instance ready, waiting for first brief
  | "brief_ready"     // State 3: Brief is ready to show
  | "returning_user"; // State 4: Normal dashboard

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
// Progress bar component
// ---------------------------------------------------------------------------

function GoldProgressBar({ active }: { active: boolean }) {
  if (!active) return null;
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
        }}
        style={{ width: "40%" }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Brief display component
// ---------------------------------------------------------------------------

function BriefDisplay({ content }: { content: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 1.2, ease: "easeOut" }}
      className="mx-auto mt-8 max-w-[600px] px-6"
    >
      <div
        className="whitespace-pre-wrap text-center text-[#F0EDE8] leading-relaxed"
        style={{ fontFamily: "'EB Garamond', 'Georgia', serif", fontSize: "1.1rem" }}
      >
        {content}
      </div>
    </motion.div>
  );
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
  const hasBrief = briefData?.brief != null && briefData.brief !== "";
  const hasVaultData =
    displayData?.vault?.total_records != null &&
    displayData.vault.total_records > 0;
  const isNewUser = !hasInstance && !isProvisioning && provStatus !== undefined;

  const [briefDismissed, setBriefDismissed] = useState(false);

  const onboardingState: OnboardingState = (() => {
    // If we have vault data and a brief has been seen/dismissed, returning user
    if (hasInstance && hasVaultData && (briefDismissed || !hasBrief)) {
      return "returning_user";
    }
    // If we have vault data but also have a fresh brief, could be returning user
    if (hasInstance && hasVaultData && hasBrief && !briefDismissed) {
      return "returning_user";
    }
    // Brief ready
    if (hasInstance && hasBrief) {
      return "brief_ready";
    }
    // Instance running but no brief yet
    if (hasInstance && !hasBrief) {
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
  // Auto-capture Google tokens + create Gmail stream after provisioning
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (onboardingState !== "awaiting_brief") return;

    // Check URL for oauth=success (returning from token capture redirect)
    const params = new URLSearchParams(window.location.search);
    if (params.get("oauth") === "success") {
      // Tokens captured — trigger onboarding workflow
      sessionStorage.setItem("alfred:oauth_captured", "true");
      console.info("[DashboardPage] OAuth tokens captured — triggering onboarding");
      window.history.replaceState({}, "", "/dashboard");
      startOnboarding({}).catch((err: any) => {
        console.error("[DashboardPage] onboarding workflow failed:", err);
      });
      return;
    }

    // Already captured tokens (persists across re-renders/reloads)
    if (sessionStorage.getItem("alfred:oauth_captured") === "true") {
      // Tokens already captured, just re-trigger onboarding in case it failed
      startOnboarding({}).catch(() => {});
      return;
    }

    // No tokens yet — redirect to capture them via our custom OAuth flow
    if (!authUser?.id) return;
    console.info("[DashboardPage] Redirecting to capture Google OAuth tokens");
    // Mark that we're about to redirect (prevent loop on fast reloads)
    sessionStorage.setItem("alfred:oauth_captured", "pending");
    const scopes = "https://www.googleapis.com/auth/gmail.readonly";
    window.location.href = `/auth/oauth2/google/start?userId=${authUser.id}&scopes=${encodeURIComponent(scopes)}&redirectAfter=${encodeURIComponent("/dashboard?oauth=success")}`;
  }, [onboardingState, authUser]);

  // ---------------------------------------------------------------------------
  // Brief auto-dismiss timer (30s)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (onboardingState !== "brief_ready") return;
    const timer = setTimeout(() => setBriefDismissed(true), 30_000);
    return () => clearTimeout(timer);
  }, [onboardingState]);

  // ---------------------------------------------------------------------------
  // Cycling messages
  // ---------------------------------------------------------------------------

  const provisioningMessages = [
    "Alfred is waking up",
    "Provisioning your butler",
    "Setting up your space",
    "Almost there",
  ];

  const briefMessages = [
    "Reading your emails",
    "Learning who you are",
    "Finding patterns",
    "Preparing your first brief",
  ];

  const activeMessages =
    onboardingState === "new_user" || onboardingState === "provisioning"
      ? provisioningMessages
      : onboardingState === "awaiting_brief"
        ? briefMessages
        : ["Alfred is ready"];

  const currentMessage = useCyclingMessages(activeMessages);

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

          {/* Gold progress bar — visible during provisioning and brief generation */}
          <GoldProgressBar
            active={
              onboardingState === "new_user" ||
              onboardingState === "provisioning" ||
              onboardingState === "awaiting_brief"
            }
          />

          {/* Brief display (State 3) */}
          <AnimatePresence>
            {onboardingState === "brief_ready" && briefData?.brief && (
              <BriefDisplay content={briefData.brief} />
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
                transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
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
