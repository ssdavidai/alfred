import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "wasp/client/auth";
import {
  useQuery,
  startOnboarding,
  getFirstBrief,
} from "wasp/client/operations";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AutomationCard {
  name: string;
  description: string;
  decision: "keep" | "discard" | null;
}

type Phase = "orb" | "transition" | "letter";

// ---------------------------------------------------------------------------
// Default automations (used when brief lacks structured proposals)
// ---------------------------------------------------------------------------

const DEFAULT_AUTOMATIONS: AutomationCard[] = [
  {
    name: "Morning Brief",
    description: "Daily email summary at 7am",
    decision: null,
  },
  {
    name: "Calendar Sync",
    description: "Keep your vault in sync with Google Calendar",
    decision: null,
  },
  {
    name: "Smart Triage",
    description: "Auto-classify and file incoming emails",
    decision: null,
  },
];

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function OnboardingOrbPage() {
  const navigate = useNavigate();
  const { data: user } = useAuth();

  const [phase, setPhase] = useState<Phase>("orb");
  const [orbVisible, setOrbVisible] = useState(true);
  const [onboardingStarted, setOnboardingStarted] = useState(false);
  const [briefText, setBriefText] = useState<string | null>(null);
  const mountTime = useRef(Date.now());

  // Poll for the first brief
  const { data: briefData } = useQuery(getFirstBrief, undefined, {
    refetchInterval: phase === "orb" ? 5_000 : false,
  });

  // Start onboarding on mount
  useEffect(() => {
    if (onboardingStarted) return;
    setOnboardingStarted(true);
    startOnboarding({}).catch((err: any) => {
      console.error("Failed to start onboarding:", err);
    });
  }, [onboardingStarted]);

  // Watch for brief readiness
  useEffect(() => {
    if (phase !== "orb") return;
    const brief = briefData?.brief ?? null;
    if (brief) {
      setBriefText(brief);
      // Begin transition: fade out orb
      setPhase("transition");
      setOrbVisible(false);
      // After orb fades, show letter
      setTimeout(() => {
        setPhase("letter");
      }, 1500);
    }
  }, [briefData, phase]);

  // Get user's first name for the salutation
  const userName = (user as any)?.username || (user as any)?.email?.split("@")[0] || "Friend";

  return (
    <>
      <style>{`
        @keyframes orbPulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.15); }
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes letterFadeIn {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <div
        style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "#000",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          overflow: "auto",
          zIndex: 9999,
        }}
      >
        {(phase === "orb" || phase === "transition") && (
          <OrbPhase
            visible={orbVisible}
            mountTime={mountTime.current}
          />
        )}
        {phase === "letter" && briefText && (
          <LetterPhase
            userName={userName}
            briefText={briefText}
            onComplete={() => navigate("/dashboard")}
          />
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Orb Phase
// ---------------------------------------------------------------------------

function OrbPhase({
  visible,
  mountTime,
}: {
  visible: boolean;
  mountTime: number;
}) {
  const [timeoutText, setTimeoutText] = useState<string | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      const elapsed = Date.now() - mountTime;
      if (elapsed > 10 * 60 * 1000) {
        setTimeoutText("Almost ready");
      } else if (elapsed > 5 * 60 * 1000) {
        setTimeoutText("Still reading your world...");
      }
    }, 30_000);
    return () => clearInterval(interval);
  }, [mountTime]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "48px",
        opacity: visible ? 1 : 0,
        transition: "opacity 1.5s ease-in-out",
      }}
    >
      {/* The Orb */}
      <div
        style={{
          width: 120,
          height: 120,
          borderRadius: "50%",
          background:
            "radial-gradient(circle at 50% 50%, #C9A84C 0%, rgba(201,168,76,0.3) 40%, transparent 70%)",
          boxShadow: "0 0 80px rgba(201,168,76,0.4), 0 0 160px rgba(201,168,76,0.15)",
          animation: "orbPulse 3.5s ease-in-out infinite",
        }}
      />

      {/* Text below orb */}
      <div
        style={{
          animation: "fadeIn 1s ease-in-out 1s both",
          textAlign: "center",
        }}
      >
        <p
          style={{
            fontVariant: "small-caps",
            letterSpacing: "0.2em",
            color: "#C9A84C",
            fontSize: 14,
            lineHeight: 2,
            margin: 0,
            fontFamily: "'EB Garamond', 'Georgia', serif",
          }}
        >
          {timeoutText || (
            <>
              Alfred is coming to life.
              <br />
              I'm reading your world now.
              <br />
              This will take a moment.
            </>
          )}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Letter Phase
// ---------------------------------------------------------------------------

function LetterPhase({
  userName,
  briefText,
  onComplete,
}: {
  userName: string;
  briefText: string;
  onComplete: () => void;
}) {
  const [automations, setAutomations] = useState<AutomationCard[]>(
    () => [...DEFAULT_AUTOMATIONS]
  );
  const [allDecided, setAllDecided] = useState(false);
  const [showDone, setShowDone] = useState(false);

  // Split brief into paragraphs (take first 5 meaningful ones)
  const paragraphs = briefText
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .slice(0, 5);

  const handleDecision = useCallback(
    (index: number, decision: "keep" | "discard") => {
      setAutomations((prev: typeof automations) => {
        const next = [...prev];
        next[index] = { ...next[index], decision };
        return next;
      });
    },
    []
  );

  // Check if all decided
  useEffect(() => {
    const decided = automations.every((a: { decision: string | null }) => a.decision !== null);
    if (decided && !allDecided) {
      setAllDecided(true);
      // Show done message, then redirect
      setTimeout(() => setShowDone(true), 300);
      setTimeout(() => onComplete(), 2300);
    }
  }, [automations, allDecided, onComplete]);

  return (
    <div
      style={{
        width: "100%",
        maxWidth: 600,
        margin: "0 auto",
        padding: "64px 24px",
        animation: "letterFadeIn 1.2s ease-out both",
      }}
    >
      {/* Salutation */}
      <p
        style={{
          fontFamily: "'EB Garamond', 'Georgia', serif",
          fontSize: 24,
          color: "#F0EDE8",
          marginBottom: 32,
          fontWeight: 400,
          fontStyle: "italic",
        }}
      >
        {userName},
      </p>

      {/* Brief paragraphs */}
      <div style={{ marginBottom: 48 }}>
        {paragraphs.map((p: string, i: number) => (
          <p
            key={i}
            style={{
              fontFamily: "'EB Garamond', 'Georgia', serif",
              fontSize: 18,
              lineHeight: 1.8,
              color: "#F0EDE8",
              marginBottom: 24,
              fontWeight: 400,
              animation: `fadeIn 0.8s ease-in-out ${0.3 + i * 0.15}s both`,
            }}
            dangerouslySetInnerHTML={{
              __html: p
                .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
                .replace(/\*(.+?)\*/g, "<em>$1</em>")
                .replace(/\n/g, "<br />"),
            }}
          />
        ))}
      </div>

      {/* Automation cards */}
      <div
        style={{
          marginBottom: 48,
          animation: `fadeIn 0.8s ease-in-out ${0.3 + paragraphs.length * 0.15}s both`,
        }}
      >
        <p
          style={{
            fontFamily: "'EB Garamond', 'Georgia', serif",
            fontSize: 18,
            lineHeight: 1.8,
            color: "#F0EDE8",
            marginBottom: 24,
          }}
        >
          I've prepared three automations to get us started. Keep what serves you; discard what doesn't.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {automations.map((auto: any, i: number) => (
            <div
              key={auto.name}
              style={{
                border: "1px solid #222",
                borderRadius: 2,
                padding: "20px 24px",
                backgroundColor:
                  auto.decision === "keep"
                    ? "rgba(201,168,76,0.05)"
                    : auto.decision === "discard"
                      ? "rgba(100,100,100,0.05)"
                      : "rgba(17,17,17,0.6)",
                transition: "all 0.3s ease",
                animation: `fadeIn 0.6s ease-in-out ${0.5 + paragraphs.length * 0.15 + i * 0.1}s both`,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                }}
              >
                <div>
                  <p
                    style={{
                      fontFamily: "'DM Sans', sans-serif",
                      fontSize: 15,
                      fontWeight: 500,
                      color: "#F0EDE8",
                      margin: 0,
                      marginBottom: 4,
                    }}
                  >
                    {auto.name}
                  </p>
                  <p
                    style={{
                      fontFamily: "'DM Sans', sans-serif",
                      fontSize: 13,
                      color: "#8A8680",
                      margin: 0,
                    }}
                  >
                    {auto.description}
                  </p>
                </div>

                {auto.decision === null ? (
                  <div style={{ display: "flex", gap: 16, flexShrink: 0, marginLeft: 16 }}>
                    <button
                      onClick={() => handleDecision(i, "keep")}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        fontFamily: "'DM Sans', sans-serif",
                        fontSize: 13,
                        color: "#C9A84C",
                        textDecoration: "underline",
                        textUnderlineOffset: "3px",
                        padding: "4px 0",
                      }}
                    >
                      Keep
                    </button>
                    <button
                      onClick={() => handleDecision(i, "discard")}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        fontFamily: "'DM Sans', sans-serif",
                        fontSize: 13,
                        color: "#666",
                        textDecoration: "underline",
                        textUnderlineOffset: "3px",
                        padding: "4px 0",
                      }}
                    >
                      Discard
                    </button>
                  </div>
                ) : (
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: "0.1em",
                      color: auto.decision === "keep" ? "#C9A84C" : "#555",
                      flexShrink: 0,
                      marginLeft: 16,
                      padding: "4px 0",
                    }}
                  >
                    {auto.decision === "keep" ? "Kept" : "Discarded"}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Sign-off */}
      <p
        style={{
          fontFamily: "'EB Garamond', 'Georgia', serif",
          fontSize: 18,
          color: "#F0EDE8",
          fontStyle: "italic",
          marginBottom: 48,
          animation: `fadeIn 0.8s ease-in-out ${0.8 + paragraphs.length * 0.15}s both`,
        }}
      >
        — Alfred
      </p>

      {/* Done message */}
      {showDone && (
        <div
          style={{
            textAlign: "center",
            animation: "fadeIn 0.8s ease-in-out both",
          }}
        >
          <p
            style={{
              fontVariant: "small-caps",
              letterSpacing: "0.2em",
              color: "#C9A84C",
              fontSize: 14,
              fontFamily: "'EB Garamond', 'Georgia', serif",
            }}
          >
            Done. Your Alfred is fully set up.
          </p>
        </div>
      )}
    </div>
  );
}
