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
//       · no `connected` marker → show the "Start onboarding" CTA.
//       · marker present + Gmail connected → auto-fire startOnboarding({})
//         once (useRef-guarded), then route into the ritual at /awaken.
//       · marker present + not connected yet → brief "connecting" state
//         while the connection settles, then retry.
//   any other stage (backfill/processing/.../awaiting_verification/brief)
//                                        → onboarding already running:
//       route the principal into the ritual page that matches `stage`.
//
// The ritual pages (/awaken → … → /first-brief) already poll
// getOnboardingProgress and advance on the real pipeline `stage`, so once
// the gate hands off, the rest runs on its own.
//
// ─── Gmail onboarding mode (Composio-managed Gmail onboarding, #68) ──────
//
// The "connect Gmail" step has two implementations, chosen by the
// server-resolved `onboardingGmailMode` (getOnboardingGmailMode query,
// #67):
//
//   mode = "google"   — the legacy direct path: redirect the browser to
//                       /auth/oauth2/google/start (a custom Wasp/Google
//                       OAuth client with the gmail.readonly scope), which
//                       writes an OAuthCredential row and bounces back with
//                       ?onboarding=connected. UNCHANGED — byte-identical
//                       to the pre-#68 behaviour.
//   mode = "composio" — Composio's managed Google OAuth: reuse the Lane E
//                       connection lifecycle (initiateConnect → popup →
//                       poll for ACTIVE → finalizeComposioConnections), the
//                       same machinery ConnectionsPage uses. No Google
//                       OAuth client / no OAuthCredential row; the token
//                       lives in Composio's backend. "Connected" is
//                       detected with getGmailConnectionStatus.
//   mode = "none"     — neither COMPOSIO_API_KEY nor GOOGLE_CLIENT_* is
//                       configured: onboarding's Gmail step genuinely
//                       cannot run. The CTA is disabled with an explicit
//                       misconfiguration note rather than dead-ending.
//
// In both working modes the gate converges on the same auto-trigger:
// once Gmail is connected and the `connected` marker is set, it fires
// startOnboarding({}) exactly once and routes into the ritual.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "wasp/client/auth";
import {
  useQuery,
  useAction,
  getOnboardingProgress,
  getOnboardingGmailMode,
  getGoogleRefreshTokenStatus,
  getGmailConnectionStatus,
  initiateConnect,
  finalizeComposioConnections,
  startOnboarding,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import { Seal } from "../client/components/ab/Seal";
import { PageOverture } from "../client/components/ab/PageOverture";

const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

// The Composio toolkit slug for Gmail. Confirmed against ctrl-api's
// RECOMMENDED_STREAMS / GMAIL_FETCH_EMAILS action mapping.
const GMAIL_TOOLKIT_SLUG = "gmail";

// URL marker carried back from the Gmail-connect round-trip so the gate
// knows the principal just connected Gmail and the auto-trigger should
// fire. In `google` mode it's carried on the OAuth redirect's
// redirectAfter; in `composio` mode the popup-poll sets it directly once
// the connection lands ACTIVE (Composio's popup redirect can't be relied
// on to reach this page, so the poll is authoritative).
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
    // All the pre-verify "Alfred is working" stages render on the theatre
    // page, whose act indicator follows the real stage (reading → working out
    // who you are → patterns → composing his soul). personalize is BEFORE
    // awaiting_verification, so it must NOT route to /composing (the
    // post-verify brief interstitial) — that skipped /verify and dumped the
    // user on an empty brief.
    case "metadata":
    case "backfill":
    case "processing":
    case "facts":
    case "patterns":
    case "personalize":
      return "/reading-the-room";
    // Facts are ready — pause here for the principal to confirm them.
    case "awaiting_verification":
      return "/verify";
    // The brief generates AFTER the principal verifies facts.
    case "automations":
    case "brief":
      return "/composing";
    // Post-brief background generation (matter/instinct/errand packs, then
    // chore code-gen). The brief is already composed — never bounce these to
    // the top of the ritual; show the brief at worst.
    case "packs":
    case "chores":
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

  // Which Gmail-connect implementation this deployment uses (#67).
  const { data: gmailMode, isLoading: modeLoading } = useQuery(
    getOnboardingGmailMode,
    undefined,
    { retry: false },
  );
  const mode = gmailMode?.mode ?? null;

  // `google` mode: the legacy OAuthCredential-row check.
  const { data: tokenStatus, isLoading: tokenLoading } = useQuery(
    getGoogleRefreshTokenStatus,
    undefined,
    { retry: false },
  );

  // `composio` mode: an ACTIVE `gmail` Composio connection on the tenant.
  // Polled so the gate notices the connection landing ACTIVE even if the
  // popup-poll missed the race (Composio's INITIATED → ACTIVE flip).
  // `refetchGmailConnection` is also driven imperatively by the popup-poll
  // after the consent window closes.
  const {
    data: gmailConnection,
    isLoading: gmailConnLoading,
    refetch: refetchGmailConnection,
  } = useQuery(getGmailConnectionStatus, undefined, {
    retry: false,
    refetchInterval: 5_000,
  });

  const startOnboardingFn = useAction(startOnboarding);

  // The marker may already be on the URL (the `google`-mode OAuth
  // round-trip carries it back). In `composio` mode the popup-poll sets
  // it via state instead — so the marker is stateful, not URL-only.
  const [hasMarker, setHasMarker] = useState(() => {
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
  // A transient ctrl-api fetch error surfaces as stage="fetch_error"
  // (operations.getOnboardingProgress) — indeterminate, NOT "not started".
  // Treat it like the complete stages: render the Desk, show no CTA, do not
  // bounce into the ritual. The 5s poll retries and resolves the real stage,
  // so an onboarded principal is never kicked back to onboarding on a hiccup
  // (FAILURE-MODES web bug #4).
  const isFetchError = stage === "fetch_error";
  // The interactive ritual ends at the brief. The post-brief stages
  // (packs / chores) generate matters, instincts, errands and bespoke chore
  // workflows in the BACKGROUND — by then the principal has seen their brief
  // and should be allowed onto the Desk, not bounced back into the ritual
  // (the default ritual route for an unhandled stage is /awaken). Treat them,
  // and "done", as complete for gating.
  const COMPLETE_STAGES = new Set(["done", "packs", "chores"]);
  const isDone = COMPLETE_STAGES.has(stage);
  const isRunning = !isNotStarted && !isDone && !isFetchError && stage !== "";

  // Whichever mode is active, this is "Gmail is connected" — the gate's
  // single connected-detection signal. In `google` mode it's the
  // OAuthCredential row; in `composio` mode it's an ACTIVE `gmail`
  // Composio connection. `none` mode can never be connected.
  const gmailConnected =
    mode === "composio"
      ? Boolean(gmailConnection?.connected)
      : mode === "google"
        ? Boolean(tokenStatus?.hasCredential)
        : false;

  // True while the connected-detection query for the active mode is
  // still loading — used to decide whether to show the "finishing" hold.
  const connectedStatusLoading =
    mode === "composio"
      ? gmailConnLoading
      : mode === "google"
        ? tokenLoading
        : false;

  // Guards so each side effect fires exactly once.
  const onboardingTriggered = useRef(false);
  const ritualRedirected = useRef(false);

  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  // `composio` mode connect-popup state.
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  // Single-fire guard for the Composio popup-poll loop (a second CTA
  // click while a popup is open must not open a second poll).
  const composioPollActive = useRef(false);

  // ---------------------------------------------------------------------
  // Auto-trigger: Gmail just connected (marker set, onboarding still not
  // started, the active-mode connected check is true) → fire
  // startOnboarding({}) once and route into the ritual. Mode-agnostic:
  // both the `google` OAuth return and the `composio` popup-poll converge
  // here once `hasMarker` + `gmailConnected` are both true.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!hasMarker) return;
    if (progressLoading || modeLoading) return;
    if (!isNotStarted) return; // already running / done — nothing to do
    if (onboardingTriggered.current) return;

    // Not connected yet — the OAuth callback / Composio connection may
    // still be settling. Hold; the queries refetch and this effect
    // re-runs once `gmailConnected` flips true.
    if (!gmailConnected) return;

    onboardingTriggered.current = true;
    setTriggering(true);

    // Strip the marker so a reload doesn't re-arm the trigger.
    setHasMarker(false);
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
    modeLoading,
    isNotStarted,
    gmailConnected,
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
  // CTA click — `google` mode. Mirrors the original DashboardPage flow:
  // redirect to the Wasp Google OAuth start URL with the gmail.readonly
  // scope and a redirectAfter that carries the connected marker.
  // UNCHANGED from the pre-#68 behaviour.
  // ---------------------------------------------------------------------
  function startGoogleOnboarding() {
    if (!user?.id) return;
    const params = new URLSearchParams({
      userId: String(user.id),
      scopes: GMAIL_READONLY_SCOPE,
      redirectAfter: `/desk?onboarding=${CONNECTED_MARKER}`,
    });
    window.location.href = `/auth/oauth2/google/start?${params.toString()}`;
  }

  // ---------------------------------------------------------------------
  // CTA click — `composio` mode. Reuses the Lane E connection lifecycle
  // (the same mechanism ConnectionsPage drives): initiateConnect for the
  // `gmail` toolkit, open the Composio-managed Google consent in a named
  // popup, poll `popup.closed`, then re-read getGmailConnectionStatus
  // until the connection lands ACTIVE. On ACTIVE: run
  // finalizeComposioConnections (auto-config the connection, same as
  // ConnectionsPage's post-connect sweep) and set the `connected` marker
  // so the mode-agnostic auto-trigger above fires startOnboarding.
  // ---------------------------------------------------------------------
  async function startComposioOnboarding() {
    if (!user?.id) return;
    if (composioPollActive.current) return; // popup already open
    composioPollActive.current = true;
    setConnecting(true);
    setConnectError(null);
    try {
      // Pass an explicit redirect_url so Composio knows where to send the
      // popup after consent — matches ConnectionsPage's startOAuth. The
      // popup-close poll is authoritative; the redirect is a courtesy.
      const result: any = await initiateConnect({
        toolkit_slug: GMAIL_TOOLKIT_SLUG,
        redirect_url: `${window.location.origin}/desk?onboarding=${CONNECTED_MARKER}`,
      });
      // ctrl-api returns `connect_url` (not `redirect_url`).
      const connectUrl: string | undefined = result?.connect_url;
      if (!connectUrl) {
        composioPollActive.current = false;
        setConnecting(false);
        setConnectError(
          "Alfred could not start the Gmail connection. Please try again.",
        );
        return;
      }

      // Named popup so a second click reuses the same window. Polling
      // popup.closed is the only reliable signal — OAuth redirects
      // between Composio and Google blow away postMessage.
      const popup = window.open(
        connectUrl,
        "composio-gmail-connect",
        "width=600,height=700,left=200,top=100",
      );
      if (!popup) {
        composioPollActive.current = false;
        setConnecting(false);
        setConnectError(
          "Alfred could not open the Gmail consent window. Please allow popups and try again.",
        );
        return;
      }

      // After the popup closes, poll getGmailConnectionStatus for the
      // connection becoming ACTIVE (Composio's INITIATED → ACTIVE race),
      // then finalize (auto-config) and arm the marker. Bounded retry
      // (6 × 2s); the background getGmailConnectionStatus poll is the
      // safety net for a late ACTIVE flip.
      const closeWatch = setInterval(async () => {
        if (!popup.closed) return;
        clearInterval(closeWatch);
        clearTimeout(hardCap);
        let landed = false;
        for (let attempt = 0; attempt < 6; attempt++) {
          try {
            const refreshed = await refetchGmailConnection();
            if (refreshed?.data?.connected) {
              landed = true;
              break;
            }
          } catch (e) {
            console.warn("[DeskOnboardingGate] gmail status poll failed", e);
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (landed) {
          // Auto-config the connection (streams + skill + gateway tools),
          // the same finalize sweep ConnectionsPage runs post-connect.
          // Best-effort — onboarding can proceed even if this is slow.
          try {
            await finalizeComposioConnections();
          } catch (e) {
            console.warn(
              "[DeskOnboardingGate] finalizeComposioConnections failed",
              e,
            );
          }
          // Arm the marker → the mode-agnostic auto-trigger effect fires
          // startOnboarding once the polled status confirms `connected`.
          setHasMarker(true);
        } else {
          // Popup closed without an ACTIVE connection in ~12s — user
          // cancelled, or Composio is slow. The background
          // getGmailConnectionStatus poll will catch a late ACTIVE flip;
          // until then, re-show the CTA.
          setConnectError(
            "The Gmail connection didn't complete. Please try again.",
          );
        }
        composioPollActive.current = false;
        setConnecting(false);
      }, 500);

      // Hard cap: 2 min, then stop polling regardless.
      const hardCap = setTimeout(() => {
        clearInterval(closeWatch);
        composioPollActive.current = false;
        setConnecting(false);
      }, 120_000);
    } catch (e) {
      console.error("[DeskOnboardingGate] composio connect failed", e);
      composioPollActive.current = false;
      setConnecting(false);
      setConnectError(
        "Alfred could not start the Gmail connection. Please try again.",
      );
    }
  }

  // The CTA dispatches on mode. `none` is handled in the render branch
  // (the button is disabled) so this is never called for it.
  function startOnboardingRitual() {
    if (mode === "composio") {
      void startComposioOnboarding();
      return;
    }
    // Default + `google` mode: the legacy direct-Google redirect.
    startGoogleOnboarding();
  }

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  // First load — hold until getOnboardingProgress (and the Gmail mode)
  // resolve so a returning principal (stage="done") never sees the CTA
  // flash. The one exception is a marker return: the auto-trigger effect
  // needs to run its connecting/finishing states immediately, so don't
  // hold there.
  if ((progressLoading || modeLoading) && !hasMarker) {
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

  // Marker present + Gmail connected + trigger in flight (or about to be)
  // — show a connecting state rather than the CTA.
  if (hasMarker && (triggering || (!triggerError && gmailConnected))) {
    return (
      <GateShell
        title="Connecting Gmail."
        body="Alfred is opening his ledger — this takes a moment."
      />
    );
  }

  // Marker present but not connected yet — the connection is still
  // settling. Brief hold; the auto-trigger effect retries on refetch.
  if (
    hasMarker &&
    !connectedStatusLoading &&
    !gmailConnected &&
    !triggerError
  ) {
    return (
      <GateShell
        title="Finishing the connection."
        body="One moment while Gmail is linked to your account."
      />
    );
  }

  // `composio` mode — the popup-poll is in flight (popup open, or
  // polling for ACTIVE). Show a connecting hold instead of the CTA.
  if (connecting && !triggerError) {
    return (
      <GateShell
        title="Connecting Gmail."
        body="Finish the Google consent in the window Alfred opened."
      />
    );
  }

  // The Gmail step genuinely cannot run — neither COMPOSIO_API_KEY nor
  // GOOGLE_CLIENT_* is configured. Surface the misconfiguration rather
  // than dead-ending on a button that goes nowhere.
  const misconfigured = mode === "none";
  const ctaError = triggerError ?? connectError;

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

            {misconfigured && (
              <p
                className="font-body italic mt-6 text-[15px]"
                style={{ color: "var(--brass)" }}
              >
                Gmail onboarding isn't configured on this instance — neither
                a Composio API key nor a Google OAuth client is set. Ask
                your administrator to configure one before onboarding can
                begin.
              </p>
            )}

            {ctaError && (
              <p
                className="font-body italic mt-6 text-[15px]"
                style={{ color: "var(--brass)" }}
              >
                {ctaError}
              </p>
            )}

            <div className="mt-9 flex items-baseline gap-6">
              <button
                type="button"
                onClick={startOnboardingRitual}
                disabled={!user?.id || misconfigured}
                className="btn-brass"
                style={{ fontSize: "1rem" }}
              >
                Start onboarding →
              </button>
              <span
                className="font-mono text-[10px] uppercase tracking-[0.22em]"
                style={{ color: "var(--marginalia)" }}
              >
                {misconfigured
                  ? "Gmail connection unavailable"
                  : mode === "composio"
                    ? "Connect Gmail · managed by Composio"
                    : "Connect Gmail · gmail.readonly"}
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
