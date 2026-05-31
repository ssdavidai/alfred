// ProfileNewPage — wizard for creating a new Hermes profile (#120 Lane III).
//
// Single-form, no multi-step flow. The principal types:
//   * Label   (required) → human-readable name ("Cratchit", "Field Foreman")
//   * Slug    (required) → kebab-case, auto-derived from Label, editable
//   * Description (optional)
//   * Model   (required) → dropdown of the small whitelist Sir trusts
//   * Persona template (optional, textarea) — seeds the profile's SOUL.md
//
// On Save: calls `createAgentProfile`, redirects to /profiles/<slug> on
// success. The detail page shows "Provisioning Sentinel… ~30s" via its
// own status polling (StatusPill='pending').
//
// Slug regex client-side mirrors the server-side `^[a-z][a-z0-9-]{1,30}$`
// so we catch shape errors before the round-trip. Reserved-slug rejection
// stays server-side (it surfaces as a 409 from ctrl-api which we show
// verbatim).
import { useEffect, useMemo, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { createAgentProfile } from "wasp/client/operations";
import { Frame, PageHeading } from "../client/components/ab/Frame";

const SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;

// Small curated allowlist. Sir's existing infra profiles use these
// exact strings, and the OpenRouter side of Hermes resolves them by
// substring — so keep the values verbatim.
const MODEL_CHOICES: { value: string; label: string }[] = [
  { value: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Anthropic)" },
  { value: "anthropic/claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (fast)" },
  { value: "anthropic/claude-opus-4-7", label: "Claude Opus 4.7 (heavy)" },
  { value: "openai/gpt-5.4-mini", label: "GPT-5.4 mini (OpenAI)" },
  { value: "openai/gpt-5.4-nano", label: "GPT-5.4 nano (fast)" },
  { value: "x-ai/grok-4.3", label: "Grok 4.3 (xAI)" },
];

function deriveSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 31);
}

// #206 Q5 — suggested tones (free-text, but show the principal the shapes
// the team has converged on). The input still accepts anything.
const TONE_SUGGESTIONS = ["formal", "dry", "warm", "clipped", "blunt"];

export default function ProfileNewPage() {
  const navigate = useNavigate();
  const [label, setLabel] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [model, setModel] = useState(MODEL_CHOICES[0].value);
  const [personaTemplate, setPersonaTemplate] = useState("");
  // #206 Q5 — three optional bootstrap questions that materialize RULES.md
  // and daybook.md on the profile dir. ctrl-api (Lane I) writes both files
  // iff the relevant inputs are non-empty; otherwise it skips silently.
  const [role, setRole] = useState("");
  const [tone, setTone] = useState("");
  const [firstActionsRaw, setFirstActionsRaw] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-derive slug from label until the user types in the slug field.
  useEffect(() => {
    if (!slugTouched) {
      setSlug(deriveSlug(label));
    }
  }, [label, slugTouched]);

  const slugValid = useMemo(() => SLUG_RE.test(slug), [slug]);
  const labelValid = label.trim().length > 0;
  const canSubmit = slugValid && labelValid && model.trim().length > 0;

  async function submit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // #206 Q5 — split first_actions on newlines, trim, drop empties.
      // Cap at 10 lines client-side (server re-validates). Each line is
      // ≤200 chars; we truncate visually but let ctrl-api be the source
      // of truth on validation.
      const firstActions = firstActionsRaw
        .split(/\r?\n/)
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0)
        .slice(0, 10);
      const result = await createAgentProfile({
        slug,
        label: label.trim(),
        model,
        description: description.trim() || undefined,
        persona_template: personaTemplate.trim() || undefined,
        role: role.trim() || undefined,
        tone: tone.trim() || undefined,
        first_actions: firstActions.length > 0 ? firstActions : undefined,
      });
      // ctrl-api returns { profile, note }; profile.slug is what we want.
      const created = (result as any)?.profile;
      const createdSlug = created?.slug ?? slug;
      navigate(`/profiles/${encodeURIComponent(createdSlug)}`);
    } catch (e: any) {
      // HttpError messages from ctrl-api come through verbatim (the
      // _classify mapping in profiles.ts gives clean 400/404/409
      // surfaces).
      const msg =
        e?.message || e?.data?.message || "Couldn't create the profile.";
      setError(String(msg));
      setSubmitting(false);
    }
  }

  return (
    <Frame>
      <section className="mx-auto max-w-[720px] px-8 py-12">
        <div className="mb-2">
          <Link
            to="/profiles"
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--marginalia)" }}
          >
            ← Back to profiles
          </Link>
        </div>
        <PageHeading
          kicker="New profile"
          title="A new persona for Alfred."
          lede="Give the new profile a name and a model; the rest is optional. Sir can bind channels and refine the persona later from the detail page."
          icon="calling_card"
        />

        <div className="space-y-8">
          {/* Label */}
          <div>
            <label
              className="block font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
              style={{ color: "var(--brass)" }}
            >
              Label
            </label>
            <input
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Cratchit"
              className="w-full bg-transparent outline-none border-b font-display italic text-[24px] pb-2"
              style={{ borderColor: "var(--brass)" }}
            />
            <p
              className="font-body italic text-sm mt-2"
              style={{ color: "var(--marginalia)" }}
            >
              The human name of this persona. Shown in the picker and at the
              top of every page when scoped here.
            </p>
          </div>

          {/* Slug */}
          <div>
            <label
              className="block font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
              style={{ color: "var(--brass)" }}
            >
              Slug
            </label>
            <input
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
              placeholder="cratchit"
              className="w-full bg-transparent outline-none border-b font-mono text-[16px] pb-2"
              style={{ borderColor: "var(--brass)" }}
            />
            <p
              className="font-body italic text-sm mt-2"
              style={{ color: slugValid ? "var(--marginalia)" : "#B85C5C" }}
            >
              {slugValid
                ? "Used in URLs and the registry. Auto-derived from the label; edit if you'd prefer."
                : "Must be kebab-case: lowercase letters, digits, hyphens; start with a letter; 2–31 chars."}
            </p>
          </div>

          {/* Description */}
          <div>
            <label
              className="block font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
              style={{ color: "var(--brass)" }}
            >
              Description
              <span
                className="ml-2 font-body italic normal-case"
                style={{ color: "var(--marginalia)", letterSpacing: 0 }}
              >
                (optional)
              </span>
            </label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A bookkeeper for the construction side."
              className="w-full bg-transparent outline-none border-b font-body text-[16px] pb-2"
              style={{ borderColor: "var(--rule)" }}
            />
          </div>

          {/* Model */}
          <div>
            <label
              className="block font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
              style={{ color: "var(--brass)" }}
            >
              Model
            </label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full bg-transparent outline-none border-b font-mono text-[14px] pb-2"
              style={{ borderColor: "var(--brass)" }}
            >
              {MODEL_CHOICES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <p
              className="font-body italic text-sm mt-2"
              style={{ color: "var(--marginalia)" }}
            >
              Sentinel will route every turn for this profile to this model.
              Each profile pins its own.
            </p>
          </div>

          {/* Persona template */}
          <div>
            <label
              className="block font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
              style={{ color: "var(--brass)" }}
            >
              Persona template
              <span
                className="ml-2 font-body italic normal-case"
                style={{ color: "var(--marginalia)", letterSpacing: 0 }}
              >
                (optional — seeds SOUL.md)
              </span>
            </label>
            <textarea
              value={personaTemplate}
              onChange={(e) => setPersonaTemplate(e.target.value)}
              placeholder={
                'Leave blank for the default butler persona, or write a brief.\n\ne.g. "You are Cratchit, a precise and quiet bookkeeper. You speak in short, dry sentences. You never volunteer opinions. You serve Sir on construction-related matters only."'
              }
              rows={8}
              className="w-full bg-transparent outline-none border p-3 font-body text-[14px] leading-6"
              style={{ borderColor: "var(--rule)" }}
            />
          </div>

          {/* #206 Q5: role (optional — seeds RULES.md) */}
          <div>
            <label
              className="block font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
              style={{ color: "var(--brass)" }}
            >
              Role
              <span
                className="ml-2 font-body italic normal-case"
                style={{ color: "var(--marginalia)", letterSpacing: 0 }}
              >
                (optional — what does this profile play?)
              </span>
            </label>
            <input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="e.g. household bookkeeper"
              maxLength={200}
              className="w-full bg-transparent outline-none border-b font-body text-[16px] pb-2"
              style={{ borderColor: "var(--rule)" }}
            />
            <p
              className="font-body italic text-sm mt-2"
              style={{ color: "var(--marginalia)" }}
            >
              One line; up to 200 characters. Lands in RULES.md.
            </p>
          </div>

          {/* #206 Q5: tone (optional — seeds RULES.md) */}
          <div>
            <label
              className="block font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
              style={{ color: "var(--brass)" }}
            >
              Tone
              <span
                className="ml-2 font-body italic normal-case"
                style={{ color: "var(--marginalia)", letterSpacing: 0 }}
              >
                (optional — how should it speak?)
              </span>
            </label>
            <input
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              placeholder="e.g. dry"
              maxLength={64}
              className="w-full bg-transparent outline-none border-b font-body text-[16px] pb-2"
              style={{ borderColor: "var(--rule)" }}
            />
            <p
              className="font-body italic text-sm mt-2"
              style={{ color: "var(--marginalia)" }}
            >
              Free text. Suggestions:{" "}
              {TONE_SUGGESTIONS.map((s: string, i: number) => (
                <span key={s}>
                  <button
                    type="button"
                    onClick={() => setTone(s)}
                    className="font-mono text-[12px] underline"
                    style={{ color: "var(--brass)" }}
                  >
                    {s}
                  </button>
                  {i < TONE_SUGGESTIONS.length - 1 ? " · " : ""}
                </span>
              ))}
              .
            </p>
          </div>

          {/* #206 Q5: first_actions (optional — seeds daybook.md) */}
          <div>
            <label
              className="block font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
              style={{ color: "var(--brass)" }}
            >
              First three things this profile should do
              <span
                className="ml-2 font-body italic normal-case"
                style={{ color: "var(--marginalia)", letterSpacing: 0 }}
              >
                (optional — one per line, max 10)
              </span>
            </label>
            <textarea
              value={firstActionsRaw}
              onChange={(e) => setFirstActionsRaw(e.target.value)}
              placeholder={
                "Reconcile Sunday's grocery receipts against Sure\nFlag any subscription that auto-renewed this week\nDraft the monthly household budget memo"
              }
              rows={5}
              className="w-full bg-transparent outline-none border p-3 font-body text-[14px] leading-6"
              style={{ borderColor: "var(--rule)" }}
            />
            <p
              className="font-body italic text-sm mt-2"
              style={{ color: "var(--marginalia)" }}
            >
              One per line. Up to 10 lines, 200 characters each. Lands in
              daybook.md as a ticked checklist.
            </p>
          </div>

          {error && (
            <div
              className="border p-4 font-body"
              style={{ borderColor: "#B85C5C", color: "#B85C5C" }}
            >
              {error}
            </div>
          )}

          <div className="flex items-center gap-3 pt-4 border-t border-rule">
            <button
              onClick={submit}
              disabled={!canSubmit || submitting}
              className="btn-brass"
              style={{
                opacity: !canSubmit || submitting ? 0.5 : 1,
                cursor: !canSubmit || submitting ? "not-allowed" : "pointer",
              }}
            >
              {submitting ? "Sending to Hermes…" : "Send to Hermes"}
            </button>
            <Link to="/profiles" className="btn-ghost">
              Cancel
            </Link>
            <span
              className="font-body italic text-sm ml-auto"
              style={{ color: "var(--marginalia)" }}
            >
              Sentinel takes ~30 seconds to come up.
            </span>
          </div>
        </div>
      </section>
    </Frame>
  );
}
