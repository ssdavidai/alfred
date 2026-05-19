// DeskOnboardingGate — the missing onboarding trigger (regression fix).
//
// alfred-black's automatic-onboarding pipeline exists end-to-end
// (startOnboarding action → Gmail stream + puller schedule +
// OnboardingPipelineWorkflow) but, after the single-VM refactor gutted
// the legacy DashboardPage state machine, *nothing called it*. This gate
// restores that trigger.
//
// It wraps DeskPage. The decision tree, evaluated against the live
// `getOnboardingProgress` query:
//
//   stage = "done"                       → render the normal Desk (children)
//   stage = "not_started" / empty / null → onboarding not begun:
//       · no `?onboarding=connected` marker → show the "Start onboarding"
//         CTA. Clicking it redirects to the Wasp Google OAuth start URL
//         (gmail.readonly scope, redirectAfter back to /desk?onboarding=connected).
//       · marker present + Google credential present → auto-fire
//         startOnboarding({}) once (useRef-guarded), then route into the
//         ritual at /awaken.
//       · marker present + no credential yet → brief "connecting" state
//         while the credential row settles, then retry.
//   any other stage (backfill/processing/.../awaiting_verification/brief)
//                                        → onboarding already running:
//       route the principal into the ritual page that matches `stage`.
//
// The ritual pages (/awaken → … → /first-brief) already poll
// getOnboardingProgress and advance on the real pipeline `stage`, so once
// the gate hands off, the rest runs on its own.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "wasp/client/auth";
import {
  useQuery,
  useAction,
  getOnboardingProgress,
  getGoogleRefreshTokenStatus,
  startOnboarding,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import { Seal } from "../client/components/ab/Seal";
import { PageOverture } from "../client/components/ab/PageOverture";

const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

// URL marker carried back from the Google OAuth round-trip so the gate
// knows the principal just connected Gmail and the auto-trigger should fire.
const CONNECTED_MARKER = "connected";

// `stage` values that mean "onboarding has not begun" — the CTA shows.
const NOT_STARTED_STAGES = new Set(["", "not_started", "unknown", "new_user"]);

/** Map a live pipeline `stage` to the ritual page that renders it. The
 *  ritual pages themselves poll progress and advance, so we only need to
 *  drop the principal onto the right step. */
function ritualPathForStage(stage: string): string {
  switch (stage) {
    // Email backfill / behavioural profiling / fact extraction — the
    // "reading the room" scan page renders all of these.
    case "backfill":
    case "processing":
    case "patterns":
      return "/reading-the-room";
    // Facts are ready — pause here for the principal to confirm them.
    case "awaiting_verification":
      return "/verify";
    // Personalisation + brief composition.
    case "personalize":
    case "automations":
    case "brief":
      return "/composing";
    case "done":
      return "/first-brief";
    default:
      // Anything unrecognised but non-empty — start at the top of the
      // ritual so the principal still gets a coherent flow.
      return "/awaken";
  }
}

export default function DeskOnboardingGate({
  children,
}: {
  children: ReactNode;
}) {
  const { data: user } = useAuth();
  const navigate = useNavigate();

  // Poll onboarding progress — the single source of truth for which
  // state the principal is in. Fast-ish poll so a freshly-triggered
  // pipeline flips the gate without a manual reload.
  const { data: progress, isLoading: progressLoading } = useQuery(
    getOnboardingProgress,
    undefined,
    { refetchInterval: 5_000 },
  );

  const { data: tokenStatus, isLoading: tokenLoading } = useQuery(
    getGoogleRefreshTokenStatus,
    undefined,
    { retry: false },
  );

  const startOnboardingFn = useAction(startOnboarding);

  // The marker is read once on mount — it survives until we explicitly
  // strip it from the URL after the auto-trigger fires.
  const [hasMarker] = useState(() => {
    try {
      return (
        new URLSearchParams(window.location.search).get("onboarding") ===
        CONNECTED_MARKER
      );
    } catch {
      return false;
    }
  });

  const stage = String(progress?.stage ?? "");
  const isNotStarted = NOT_STARTED_STAGES.has(stage);
  const isDone = stage === "done";
  const isRunning = !isNotStarted && !isDone && stage !== "";

  // Guards so each side effect fires exactly once.
  const onboardingTriggered = useRef(false);
  const ritualRedirected = useRef(false);

  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  // ---------------------------------------------------------------------
  // Auto-trigger: returned from Google OAuth with the marker, onboarding
  // still not started, and a Google credential is on file → fire
  // startOnboarding({}) once and route into the ritual.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!hasMarker) return;
    if (progressLoading || tokenLoading) return;
    if (!isNotStarted) return; // already running / done — nothing to do
    if (onboardingTriggered.current) return;

    // No credential yet — the OAuth callback may still be writing the
    // OAuthCredential row. Hold; the query refetches and this effect
    // re-runs once `hasCredential` flips true.
    if (!tokenStatus?.hasCredential) return;

    onboardingTriggered.current = true;
    setTriggering(true);

    // Strip the marker so a reload doesn't re-arm the trigger.
    try {
      window.history.replaceState({}, "", "/desk");
    } catch {
      /* ignore */
    }

    startOnboardingFn({})
      .then(() => {
        navigate("/awaken");
      })
      .catch((err: any) => {
        console.error("[DeskOnboardingGate] startOnboarding failed:", err);
        setTriggerError(
          "Alfred could not begin onboarding. Please try again.",
        );
        setTriggering(false);
        // Allow a retry — the CTA re-appears.
        onboardingTriggered.current = false;
      });
  }, [
    hasMarker,
    progressLoading,
    tokenLoading,
    isNotStarted,
    tokenStatus,
    startOnboardingFn,
    navigate,
  ]);

  // ---------------------------------------------------------------------
  // Onboarding already in flight (started on a previous visit, or just
  // triggered) → route into the matching ritual page so the principal
  // watches real progress instead of staring at the Desk.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!isRunning) return;
    if (ritualRedirected.current) return;
    ritualRedirected.current = true;
    navigate(ritualPathForStage(stage));
  }, [isRunning, stage, navigate]);

  // ---------------------------------------------------------------------
  // CTA click → connect Gmail. Mirrors the original DashboardPage flow:
  // redirect to the Wasp Google OAuth start URL with the gmail.readonly
  // scope and a redirectAfter that carries the connected marker.
  // ---------------------------------------------------------------------
  function startOnboardingRitual() {
    if (!user?.id) return;
    const params = new URLSearchParams({
      userId: String(user.id),
      scopes: GMAIL_READONLY_SCOPE,
      redirectAfter: `/desk?onboarding=${CONNECTED_MARKER}`,
    });
    window.location.href = `/auth/oauth2/google/start?${params.toString()}`;
  }

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  // First load — hold until getOnboardingProgress resolves so a
  // returning principal (stage="done") never sees the CTA flash. The one
  // exception is a marker return: the auto-trigger effect needs to run
  // its connecting/finishing states immediately, so don't hold there.
  if (progressLoading && !hasMarker) {
    return <GateShell title="A moment, sir." body="Opening your desk." />;
  }

  // Onboarding complete — the Desk is the principal's home. Render it
  // untouched.
  if (isDone) return <>{children}</>;

  // Onboarding running — we're redirecting into the ritual; show a quiet
  // hold so the Desk's decision queue doesn't flash first.
  if (isRunning) {
    return <GateShell title="A moment, sir." body="Taking you to your setup." />;
  }

  // Marker present + credential present + trigger in flight (or about to
  // be) — show a connecting state rather than the CTA.
  if (hasMarker && (triggering || (!triggerError && tokenStatus?.hasCredential))) {
    return (
      <GateShell
        title="Connecting Gmail."
        body="Alfred is opening his ledger — this takes a moment."
      />
    );
  }

  // Marker present but no credential yet — the OAuth callback is still
  // settling. Brief hold; the effect above retries on refetch.
  if (hasMarker && !tokenLoading && !tokenStatus?.hasCredential && !triggerError) {
    return (
      <GateShell
        title="Finishing the connection."
        body="One moment while Gmail is linked to your account."
      />
    );
  }

  // Default not-started state — the "Start onboarding" call to action.
  return (
    <Frame>
      <section className="mx-auto max-w-[1180px] px-8 py-16">
        <PageOverture
          eyebrow="The Desk"
          title={
            <>
              Welcome
              <span style={{ fontStyle: "italic", fontWeight: 400 }}>.</span>
            </>
          }
        />

        <div className="mx-auto mt-12 max-w-[640px]">
          <article className="border border-rule p-10">
            <div
              className="font-mono text-[10px] uppercase tracking-[0.32em] mb-5"
              style={{ color: "var(--brass)" }}
            >
              Before Alfred can serve you
            </div>
            <h2
              className="font-display tracking-[-0.02em] leading-[1.04]"
              style={{ fontSize: "clamp(28px, 3.4vw, 40px)" }}
            >
              Let Alfred read the room.
            </h2>
            <p
              className="font-body mt-5 leading-[1.6]"
              style={{ color: "var(--marginalia)", fontSize: 17 }}
            >
              Alfred learns the shape of your life from your last hundred
              days of email — the people, the projects, the patterns — then
              composes your first Brief. Connect Gmail to begin. Read-only,
              and nothing leaves your own machine.
            </p>

            {triggerError && (
              <p
                className="font-body italic mt-6 text-[15px]"
                style={{ color: "var(--brass)" }}
              >
                {triggerError}
              </p>
            )}

            <div className="mt-9 flex items-baseline gap-6">
              <button
                type="button"
                onClick={startOnboardingRitual}
                disabled={!user?.id}
                className="btn-brass"
                style={{ fontSize: "1rem" }}
              >
                Start onboarding →
              </button>
              <span
                className="font-mono text-[10px] uppercase tracking-[0.22em]"
                style={{ color: "var(--marginalia)" }}
              >
                Connect Gmail · gmail.readonly
              </span>
            </div>
          </article>
        </div>
      </section>
      <Seal />
    </Frame>
  );
}

/** Minimal centred hold screen — used while the gate redirects or waits
 *  on the OAuth round-trip. Kept inside Frame for consistent chrome. */
function GateShell({ title, body }: { title: string; body: string }) {
  return (
    <Frame>
      <section className="mx-auto max-w-[640px] px-8 py-32 text-center">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.28em] mb-6"
          style={{ color: "var(--brass)" }}
        >
          A moment, sir
        </div>
        <h1 className="font-display italic text-5xl tracking-tight mb-6">
          {title}
        </h1>
        <p
          className="font-body italic text-[17px]"
          style={{ color: "var(--marginalia)" }}
        >
          {body}
        </p>
      </section>
      <Seal />
    </Frame>
  );
}
