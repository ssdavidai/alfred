import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "wasp/client/auth";
import {
  useQuery,
  startOnboarding,
  getFirstBrief,
} from "wasp/client/operations";
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useSpring,
} from "framer-motion";

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
// Gradient definitions for animated background
// ---------------------------------------------------------------------------

const GRADIENTS = [
  { color: "#C9A84C", size: 300, duration: 22, delay: 0 },
  { color: "#D4AF37", size: 250, duration: 28, delay: 2 },
  { color: "#8B7532", size: 350, duration: 34, delay: 1 },
  { color: "#FFD700", size: 200, duration: 20, delay: 3 },
  { color: "#B8860B", size: 280, duration: 40, delay: 1.5 },
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
  const userName =
    (user as any)?.username ||
    (user as any)?.email?.split("@")[0] ||
    "Friend";

  return (
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
      <AnimatePresence mode="wait">
        {(phase === "orb" || phase === "transition") && (
          <motion.div
            key="orb-phase"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 1.2, ease: "easeInOut" }}
          >
            <OrbPhase visible={orbVisible} mountTime={mountTime.current} />
          </motion.div>
        )}
        {phase === "letter" && briefText && (
          <motion.div
            key="letter-phase"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, ease: "easeOut" }}
            style={{ width: "100%", maxWidth: 600 }}
          >
            <LetterPhase
              userName={userName}
              briefText={briefText}
              onComplete={() => navigate("/dashboard")}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Animated Gradient Background
// ---------------------------------------------------------------------------

function AnimatedGradientBackground() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mouseX = useMotionValue(
    typeof window !== "undefined" ? window.innerWidth / 2 : 500,
  );
  const mouseY = useMotionValue(
    typeof window !== "undefined" ? window.innerHeight / 2 : 400,
  );
  const smoothX = useSpring(mouseX, { stiffness: 30, damping: 20 });
  const smoothY = useSpring(mouseY, { stiffness: 30, damping: 20 });

  useEffect(() => {
    const handleMouse = (e: MouseEvent) => {
      mouseX.set(e.clientX);
      mouseY.set(e.clientY);
    };
    window.addEventListener("mousemove", handleMouse);
    return () => window.removeEventListener("mousemove", handleMouse);
  }, [mouseX, mouseY]);

  // Track mouse influence per gradient
  const gradientRefs = useRef<HTMLDivElement[]>([]);

  useEffect(() => {
    let raf: number;
    const update = () => {
      const mx = smoothX.get();
      const my = smoothY.get();
      gradientRefs.current.forEach((el) => {
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = (mx - cx) * 0.04;
        const dy = (my - cy) * 0.04;
        el.style.transform = `translate(${dx}px, ${dy}px)`;
      });
      raf = requestAnimationFrame(update);
    };
    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, [smoothX, smoothY]);

  return (
    <>
      {/* SVG gooey filter for organic gradient merging */}
      <svg style={{ position: "absolute", width: 0, height: 0 }}>
        <defs>
          <filter id="gooey">
            <feGaussianBlur in="SourceGraphic" stdDeviation="40" result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7"
              result="goo"
            />
            <feComposite in="SourceGraphic" in2="goo" operator="atop" />
          </filter>
        </defs>
      </svg>

      <style>{`
        @keyframes gradient0 {
          0%, 100% { top: 20%; left: 30%; }
          25% { top: 35%; left: 55%; }
          50% { top: 50%; left: 40%; }
          75% { top: 30%; left: 20%; }
        }
        @keyframes gradient1 {
          0%, 100% { top: 60%; left: 60%; }
          25% { top: 40%; left: 35%; }
          50% { top: 25%; left: 55%; }
          75% { top: 55%; left: 45%; }
        }
        @keyframes gradient2 {
          0%, 100% { top: 40%; left: 50%; }
          25% { top: 55%; left: 25%; }
          50% { top: 35%; left: 60%; }
          75% { top: 50%; left: 40%; }
        }
        @keyframes gradient3 {
          0%, 100% { top: 30%; left: 40%; }
          25% { top: 50%; left: 60%; }
          50% { top: 60%; left: 30%; }
          75% { top: 35%; left: 50%; }
        }
        @keyframes gradient4 {
          0%, 100% { top: 55%; left: 35%; }
          25% { top: 30%; left: 50%; }
          50% { top: 45%; left: 25%; }
          75% { top: 60%; left: 55%; }
        }
      `}</style>

      <div
        ref={containerRef}
        style={{
          position: "absolute",
          inset: 0,
          overflow: "hidden",
          filter: "url(#gooey)",
        }}
      >
        {GRADIENTS.map((g, i) => (
          <motion.div
            key={i}
            ref={(el) => {
              if (el) gradientRefs.current[i] = el;
            }}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 2, delay: g.delay, ease: "easeOut" }}
            style={{
              position: "absolute",
              width: g.size,
              height: g.size,
              borderRadius: "50%",
              background: `radial-gradient(circle, ${g.color}55 0%, ${g.color}20 40%, transparent 70%)`,
              animation: `gradient${i} ${g.duration}s ease-in-out infinite`,
              marginLeft: -g.size / 2,
              marginTop: -g.size / 2,
              willChange: "top, left, transform",
            }}
          />
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Animated Text Reveal
// ---------------------------------------------------------------------------

const sentences = [
  "Alfred is coming to life.",
  "I'm reading your world now.",
  "This will take a moment.",
];

const wordVariants = {
  hidden: { opacity: 0, y: 20, filter: "blur(8px)" },
  visible: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: 0.5, ease: "easeOut" as const },
  },
};

const sentenceVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.15 } },
};

function AnimatedTextReveal() {
  const [activeSentence, setActiveSentence] = useState(0);

  useEffect(() => {
    if (activeSentence >= sentences.length - 1) return;
    const timer = setTimeout(
      () => setActiveSentence((s: number) => s + 1),
      2000,
    );
    return () => clearTimeout(timer);
  }, [activeSentence]);

  return (
    <div style={{ textAlign: "center" }}>
      <AnimatePresence mode="wait">
        <motion.p
          key={activeSentence}
          variants={sentenceVariants}
          initial="hidden"
          animate="visible"
          exit={{ opacity: 0, transition: { duration: 0.3 } }}
          style={{
            fontVariant: "small-caps",
            letterSpacing: "0.2em",
            color: "#C9A84C",
            fontSize: 14,
            lineHeight: 2,
            margin: 0,
            fontFamily: "'EB Garamond', 'Georgia', serif",
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            gap: "0 0.35em",
          }}
        >
          {sentences[activeSentence].split(" ").map((word, wi) => (
            <motion.span key={wi} variants={wordVariants}>
              {word}
            </motion.span>
          ))}
        </motion.p>
      </AnimatePresence>
    </div>
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
    <motion.div
      animate={{ opacity: visible ? 1 : 0 }}
      transition={{ duration: 1.5 }}
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Animated gradient background */}
      <AnimatedGradientBackground />

      {/* Central glow focal point */}
      <motion.div
        initial={{ opacity: 0, scale: 0.5 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 2, ease: "easeOut" }}
        style={{
          position: "relative",
          zIndex: 1,
          width: 120,
          height: 120,
          borderRadius: "50%",
          background:
            "radial-gradient(circle at 50% 50%, rgba(201,168,76,0.3) 0%, transparent 70%)",
          boxShadow:
            "0 0 80px rgba(201,168,76,0.2), 0 0 160px rgba(201,168,76,0.08)",
        }}
      />

      {/* Text below */}
      <div
        style={{
          position: "relative",
          zIndex: 1,
          marginTop: 48,
        }}
      >
        {timeoutText ? (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            style={{
              fontVariant: "small-caps",
              letterSpacing: "0.2em",
              color: "#C9A84C",
              fontSize: 14,
              lineHeight: 2,
              margin: 0,
              fontFamily: "'EB Garamond', 'Georgia', serif",
              textAlign: "center",
            }}
          >
            {timeoutText}
          </motion.p>
        ) : (
          <AnimatedTextReveal />
        )}
      </div>
    </motion.div>
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
  const [automations, setAutomations] = useState<AutomationCard[]>(() => [
    ...DEFAULT_AUTOMATIONS,
  ]);
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
    [],
  );

  // Check if all decided
  useEffect(() => {
    const decided = automations.every(
      (a: { decision: string | null }) => a.decision !== null,
    );
    if (decided && !allDecided) {
      setAllDecided(true);
      // Show done message, then redirect
      setTimeout(() => setShowDone(true), 300);
      setTimeout(() => onComplete(), 2300);
    }
  }, [automations, allDecided, onComplete]);

  const paragraphVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: (i: number) => ({
      opacity: 1,
      y: 0,
      transition: { duration: 0.8, delay: 0.3 + i * 0.2, ease: "easeOut" as const },
    }),
  };

  const automationVariants = {
    hidden: { opacity: 0, y: 40 },
    visible: (i: number) => ({
      opacity: 1,
      y: 0,
      transition: {
        type: "spring" as const,
        stiffness: 80,
        damping: 14,
        delay: 0.5 + paragraphs.length * 0.2 + i * 0.12,
      },
    }),
  };

  return (
    <div
      style={{
        width: "100%",
        maxWidth: 600,
        margin: "0 auto",
        padding: "64px 24px",
      }}
    >
      {/* Salutation */}
      <motion.p
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: "easeOut" }}
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
      </motion.p>

      {/* Brief paragraphs — staggered fade */}
      <div style={{ marginBottom: 48 }}>
        {paragraphs.map((p: string, i: number) => (
          <motion.p
            key={i}
            custom={i}
            initial="hidden"
            animate="visible"
            variants={paragraphVariants}
            style={{
              fontFamily: "'EB Garamond', 'Georgia', serif",
              fontSize: 18,
              lineHeight: 1.8,
              color: "#F0EDE8",
              marginBottom: 24,
              fontWeight: 400,
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

      {/* Automation cards — spring slide-up */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 + paragraphs.length * 0.2, duration: 0.6 }}
        style={{ marginBottom: 48 }}
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
          I've prepared three automations to get us started. Keep what serves
          you; discard what doesn't.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {automations.map((auto: any, i: number) => (
            <motion.div
              key={auto.name}
              custom={i}
              initial="hidden"
              animate="visible"
              variants={automationVariants}
              whileHover={{
                scale: 1.01,
                boxShadow: "0 0 12px rgba(201,168,76,0.1)",
              }}
              transition={{ type: "spring", stiffness: 300, damping: 20 }}
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
                transition: "background-color 0.3s ease",
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
                  <div
                    style={{
                      display: "flex",
                      gap: 16,
                      flexShrink: 0,
                      marginLeft: 16,
                    }}
                  >
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
                  <motion.span
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{
                      type: "spring",
                      stiffness: 200,
                      damping: 12,
                    }}
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
                  </motion.span>
                )}
              </div>
            </motion.div>
          ))}
        </div>
      </motion.div>

      {/* Sign-off — gold typewriter effect */}
      <SignOff delay={0.8 + paragraphs.length * 0.2} />

      {/* Done message */}
      <AnimatePresence>
        {showDone && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.8 }}
            style={{ textAlign: "center" }}
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
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sign-off with gold typewriter/fade effect
// ---------------------------------------------------------------------------

function SignOff({ delay }: { delay: number }) {
  const text = "— Alfred";
  return (
    <motion.p
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay, duration: 0.5 }}
      style={{
        fontFamily: "'EB Garamond', 'Georgia', serif",
        fontSize: 18,
        color: "#F0EDE8",
        fontStyle: "italic",
        marginBottom: 48,
        display: "flex",
      }}
    >
      {text.split("").map((char, i) => (
        <motion.span
          key={i}
          initial={{ opacity: 0, color: "#D4AF37" }}
          animate={{ opacity: 1, color: "#F0EDE8" }}
          transition={{
            delay: delay + 0.06 * i,
            duration: 0.4,
            color: { delay: delay + 0.06 * i + 0.3, duration: 0.8 },
          }}
        >
          {char === " " ? "\u00A0" : char}
        </motion.span>
      ))}
    </motion.p>
  );
}
