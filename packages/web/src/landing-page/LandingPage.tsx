// Alfred Black 1.0 — the door, the manifesto, and the waitlist.
//
// Adapted from /tmp/alfred-black-redesign/src/routes/index.tsx (#847).
// Replaces the legacy Hero/Overwhelm/KnowledgeGraph/WhatIsAlfred/LifeWithAlfred/
// EarlyAccess/Footer composition with the two-panel Door + manifesto wool, and
// folds the existing submitAccessRequest waitlist form into a third panel.
//
// CTA differs from the redesign: there is no localStorage `signIn()` here —
// the waitlist sign-in is /login.

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { submitAccessRequest } from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import { Icon } from "../client/components/ab/Icon";
import { Seal } from "../client/components/ab/Seal";
import { fadeUp, ruleDraw, titleRise } from "../client/lib/motion";

export default function LandingPage() {
  return (
    <Frame>
      <div style={{ scrollSnapType: "y mandatory" }}>
        <DoorPanel />
        <ManifestoPanel />
        <WaitlistPanel />
        <FooterLinks />
      </div>
    </Frame>
  );
}

function DoorPanel() {
  return (
    <section
      className="mx-auto max-w-[860px] px-8 flex flex-col justify-center"
      style={{ minHeight: "calc(100vh - 88px)", scrollSnapAlign: "start" }}
    >
      <h1
        className="font-display leading-[0.92] tracking-[-0.02em]"
        style={{ fontSize: "clamp(80px, 14vw, 180px)", fontWeight: 900 }}
      >
        <motion.span
          initial={{ y: 40, opacity: 0, filter: "blur(10px)" }}
          animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
          transition={{ duration: 0.95, ease: [0.16, 1, 0.3, 1] }}
          style={{ display: "inline-block" }}
        >
          Alfred
        </motion.span>
        <br />
        <motion.span
          initial={{ y: 40, opacity: 0, filter: "blur(10px)" }}
          animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
          transition={{ duration: 0.95, ease: [0.16, 1, 0.3, 1], delay: 0.55 }}
          style={{ display: "inline-block", fontStyle: "italic", fontWeight: 400 }}
        >
          Black.
        </motion.span>
      </h1>

      <motion.hr
        variants={ruleDraw}
        initial="hidden"
        animate="show"
        transition={{ delay: 1.35 }}
        style={{ originX: 0 }}
        className="gilt mt-14 mb-10"
      />

      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 1.7, ease: [0.16, 1, 0.3, 1] }}
        className="font-body text-[20px] leading-[1.55] max-w-[44ch]"
      >
        Agentic Butler. A small staff of specialists, employed on your behalf.
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 2.1, ease: [0.16, 1, 0.3, 1] }}
        className="mt-16"
      >
        <Link to="/login" className="btn-brass inline-flex items-center gap-2">
          <Icon name="skeleton_key" size={20} style={{ color: "currentColor" }} />
          Sign in &nbsp;→
        </Link>
      </motion.div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 2.6, duration: 1 }}
        className="mt-24 font-mono text-[10px] uppercase tracking-[0.32em]"
        style={{ color: "var(--marginalia)" }}
      >
        ↓ Continue
      </motion.div>
    </section>
  );
}

function ManifestoPanel() {
  return (
    <section
      className="wool relative flex items-center"
      style={{ minHeight: "calc(100vh - 88px)", scrollSnapAlign: "start" }}
    >
      <div className="mx-auto max-w-[900px] px-8">
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-20%" }}
          variants={fadeUp}
          className="font-mono text-[10px] uppercase tracking-[0.32em] mb-8"
          style={{ color: "var(--brass)" }}
        >
          By appointment
        </motion.div>
        <motion.h2
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-20%" }}
          variants={titleRise}
          className="font-display italic press leading-[1.05] tracking-[-0.01em]"
          style={{ fontSize: "clamp(36px, 5vw, 64px)" }}
        >
          Not an app you use.
          <br />
          A person you employ.
        </motion.h2>

        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-20%" }}
          variants={ruleDraw}
          transition={{ delay: 0.4 }}
          style={{ originX: 0 }}
          className="gilt mt-12 mb-8 max-w-[280px]"
        />

        <motion.p
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-20%" }}
          variants={fadeUp}
          transition={{ delay: 0.6 }}
          className="font-body text-[18px] leading-[1.65] max-w-[58ch]"
          style={{ color: "color-mix(in oklab, var(--paper) 80%, transparent)" }}
        >
          Alfred reads the correspondence, drafts the replies, holds the calendar,
          keeps the ledger. You sign what matters. The rest is settled, quietly,
          by the time you ask.
        </motion.p>
      </div>
      <Seal size={140} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Waitlist — keeps the existing submitAccessRequest action wired through, but
// restyled with the Door tokens. Form fields and submission semantics match
// the legacy EarlyAccess component byte-for-byte so existing requests still
// land in the same admin queue.
// ---------------------------------------------------------------------------

function WaitlistPanel() {
  const sectionRef = useRef<HTMLElement>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    whyNeedButler: "",
    urgency: "",
    budget: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (modalOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [modalOpen]);

  function handleChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ) {
    setFormData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      await submitAccessRequest(formData);
      setSubmitted(true);
      setTimeout(() => {
        setModalOpen(false);
        setSubmitted(false);
        setFormData({ name: "", email: "", whyNeedButler: "", urgency: "", budget: "" });
      }, 2000);
    } catch (err) {
      console.error(err);
    } finally {
      setIsSubmitting(false);
    }
  }

  const inputClass =
    "w-full border border-rule bg-transparent px-4 py-3 font-body text-[16px] outline-none transition-colors focus:border-[color:var(--brass)]";

  return (
    <>
      <section
        ref={sectionRef}
        id="early-access"
        className="paper px-8 py-32 lg:py-40"
        style={{ scrollSnapAlign: "start", minHeight: "calc(100vh - 88px)" }}
      >
        <div className="mx-auto max-w-[640px] text-center">
          <motion.div
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: "-20%" }}
            variants={fadeUp}
            className="font-mono text-[10px] uppercase tracking-[0.32em]"
            style={{ color: "var(--brass)" }}
          >
            Early access
          </motion.div>

          <motion.h2
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: "-20%" }}
            variants={titleRise}
            className="mt-8 font-display text-4xl md:text-5xl tracking-tight leading-[1.1]"
          >
            Alfred Black is in private beta.
          </motion.h2>

          <motion.div
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: "-20%" }}
            variants={ruleDraw}
            transition={{ delay: 0.4 }}
            style={{ originX: 0.5 }}
            className="gilt my-10 mx-auto max-w-[180px]"
          />

          <motion.p
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: "-20%" }}
            variants={fadeUp}
            className="font-body text-[17px] leading-[1.6]"
            style={{ color: "var(--marginalia)" }}
          >
            We are working closely with a small group of design partners before
            general availability. If you would like Alfred to consider you, drop
            your name in the top hat.
          </motion.p>

          <motion.div
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: "-20%" }}
            variants={fadeUp}
            transition={{ delay: 0.3 }}
            className="mt-12"
          >
            <button
              onClick={() => setModalOpen(true)}
              className="btn-brass inline-flex items-center gap-2"
            >
              <Icon name="top_hat" size={20} style={{ color: "currentColor" }} />
              Request access
            </button>
          </motion.div>
        </div>
      </section>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="relative w-full max-w-lg border border-rule paper p-8">
            <button
              onClick={() => setModalOpen(false)}
              className="absolute right-4 top-4 font-mono text-sm transition-colors"
              style={{ color: "var(--marginalia)" }}
              aria-label="Close"
            >
              ✕
            </button>

            {submitted ? (
              <p className="py-16 text-center font-display italic text-2xl">
                Thank you — we shall be in touch.
              </p>
            ) : (
              <form onSubmit={handleSubmit}>
                <div className="font-mono text-[10px] uppercase tracking-[0.28em]" style={{ color: "var(--brass)" }}>
                  Request early access
                </div>
                <h3 className="mt-2 font-display italic text-3xl tracking-tight">
                  Drop your name in the top hat.
                </h3>

                <div className="mt-8 space-y-5">
                  <input
                    name="name"
                    type="text"
                    placeholder="Full name"
                    required
                    value={formData.name}
                    onChange={handleChange}
                    className={inputClass}
                  />

                  <input
                    name="email"
                    type="email"
                    placeholder="Email address"
                    required
                    value={formData.email}
                    onChange={handleChange}
                    className={inputClass}
                  />

                  <textarea
                    name="whyNeedButler"
                    placeholder="Why do you need a butler?"
                    required
                    rows={3}
                    value={formData.whyNeedButler}
                    onChange={handleChange}
                    className={inputClass + " resize-none"}
                  />

                  <select
                    name="urgency"
                    required
                    value={formData.urgency}
                    onChange={handleChange}
                    className={inputClass}
                  >
                    <option value="" disabled>
                      How urgent is this for you?
                    </option>
                    <option value="Just exploring">Just exploring</option>
                    <option value="Within the next month">Within the next month</option>
                    <option value="I need this now">I need this now</option>
                  </select>

                  <select
                    name="budget"
                    required
                    value={formData.budget}
                    onChange={handleChange}
                    className={inputClass}
                  >
                    <option value="" disabled>
                      What is your monthly budget?
                    </option>
                    <option value="I don't know yet">I don't know yet</option>
                    <option value="ChatGPT Pro territory ($20/mo)">ChatGPT Pro territory ($20/mo)</option>
                    <option value="Claude Max territory ($200/mo)">Claude Max territory ($200/mo)</option>
                    <option value="Clay territory ($500–$1,000/mo)">Clay territory ($500–$1,000/mo)</option>
                    <option value="Athena territory ($1,000+/mo)">Athena territory ($1,000+/mo)</option>
                  </select>
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="btn-brass mt-8 w-full"
                >
                  {isSubmitting ? "Submitting…" : "Submit request"}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Footer links — strip of marketing destinations linked from the door. Frame
// already provides the bottom-most "Est. MMXXVI" footer; this is a quieter
// internal index, not a replacement.
// ---------------------------------------------------------------------------

const FOOTER_LINKS: Array<{ to: string; label: string }> = [
  { to: "/staff", label: "The Staff" },
  { to: "/companion", label: "Mobile" },
  { to: "/voice", label: "Voice" },
  { to: "/sms", label: "SMS" },
  { to: "/voice-and-tone", label: "Voice & tone" },
];

function FooterLinks() {
  return (
    <section className="paper border-t border-rule">
      <div className="mx-auto max-w-[1080px] px-8 py-16 grid gap-8 md:grid-cols-[1fr_auto] items-baseline">
        <div className="font-display italic text-[22px] tracking-tight max-w-[40ch]" style={{ color: "var(--marginalia)" }}>
          A few rooms in the house, should you wish to look around.
        </div>
        <ul className="flex flex-wrap gap-x-6 gap-y-3 font-mono text-[10px] uppercase tracking-[0.22em]">
          {FOOTER_LINKS.map((l) => (
            <li key={l.to}>
              <Link to={l.to} className="hover:opacity-100 transition-opacity" style={{ opacity: 0.7 }}>
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
