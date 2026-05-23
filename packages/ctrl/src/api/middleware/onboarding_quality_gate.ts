// Onboarding promotion-quality gate — Contract C-OB1.
//
// Fires on vault POST + PATCH ONLY when the write is from onboarding:
// `frontmatter.created_by ∈ {onboarding_pipeline, alfred_vault_curator}`,
// OR the request header `X-Onboarding-Write: true`. Every other vault write
// passes through untouched.
//
// `evaluateQuality` is a pure function (USER.md is cached) so the rules are
// trivially unit-testable. Rejections are mirrored into an in-memory ring
// buffer that backs GET /api/v1/onboarding/quality-report.

import fs from "node:fs";
import path from "node:path";

const ONBOARDING_CREATED_BY = new Set([
  "onboarding_pipeline",
  "alfred_vault_curator",
]);

export function shouldTrigger(opts: {
  createdBy?: string | null;
  onboardingWriteHeader?: string | string[] | null;
}): boolean {
  const cb = (opts.createdBy ?? "").trim();
  if (cb && ONBOARDING_CREATED_BY.has(cb)) return true;
  const h = opts.onboardingWriteHeader;
  const hv = Array.isArray(h) ? h[0] : h;
  if (typeof hv === "string" && hv.trim().toLowerCase() === "true") return true;
  return false;
}

export interface QualityRecord {
  kind: string;
  name: string;
  frontmatter: Record<string, unknown>;
  body: string;
  vaultRoot: string;
}

export interface QualityVerdict {
  ok: boolean;
  reason?: string;
  suggestion?: string;
}

const TLD_SUBSTRINGS = [".com", ".io", ".net", ".org", ".ai", ".co", ".so"];
const ORG_TLD_RE = /\.(com|io|net|org|ai|co|so)$/i;
const NOTIFICATIONS_RE = /Notifications?$/i;
const PER_SERVICE_NOTE_RE =
  /^[A-Za-z0-9.]+ (Service Emails|Email Digest|Activity|Notifications? Summary|Service & Notification Summary)$/;

const SUGGEST = {
  perServiceNote:
    "Route to /api/v1/state/observations with subject=email_digest, not vault/note",
  domainStubMatter:
    "Skip writing a vault matter for a sender domain — domains are senders, not principal matters",
  autoGenMatter:
    "Skip auto-generated tier=inner_circle matter stubs — promote a matter only with substantive evidence",
  nonHumanPerson:
    "Sender-identity records belong in the streams/event log, not vault/person",
  domainOrg:
    "Sender-identity records belong in the streams/event log, not vault/org",
  unearnedInstinct:
    "Onboarding-seeded instincts must start at tier=Asking, confidence_score<=0.4, status=unconfirmed (B6 at seeding)",
} as const;

function countBodyChars(body: string): number {
  // Strip any leading YAML frontmatter the caller may have left attached.
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end !== -1) return body.slice(end + 4).replace(/^\r?\n/, "").length;
  }
  return body.length;
}

// Unicode-aware uppercase detection: `\p{Lu}` matches any uppercase letter
// across scripts (Latin, Greek, Cyrillic, accented Hungarian/Polish/Czech/
// German/Spanish/…) — not just ASCII A–Z. Without the `/u` flag and the
// property escape, names like "Üveges Gábor" or "Ágnes Sirhuber" would fail
// the >=2-capitalised-tokens rule and be wrongly classified as non-human,
// silently dropping every accented-name person from a tenant's vault.
function capitalisedTokenCount(name: string): number {
  return name.split(/[\s\-]+/).filter(Boolean).filter((t) => /^\p{Lu}/u.test(t)).length;
}

// USER.md cache: ctrl-api is single-tenant per process so cardinality is 1,
// but keying by vaultRoot keeps the shape future-proof.
const userMdCache = new Map<string, { at: number; content: string }>();
const USER_MD_TTL_MS = 60_000;

function readUserMd(vaultRoot: string): string {
  const now = Date.now();
  const cached = userMdCache.get(vaultRoot);
  if (cached && now - cached.at < USER_MD_TTL_MS) return cached.content;
  let content = "";
  try {
    content = fs.readFileSync(path.join(vaultRoot, "USER.md"), "utf-8");
  } catch {
    content = "";
  }
  userMdCache.set(vaultRoot, { at: now, content });
  return content;
}

export function invalidateUserMdCache(vaultRoot?: string): void {
  if (vaultRoot) userMdCache.delete(vaultRoot);
  else userMdCache.clear();
}

/** Test-only: reset cache + ring buffer between tests. */
export function _resetQualityGateCacheForTest(): void {
  userMdCache.clear();
  rejections.length = 0;
  accepted = 0;
}

/** The C-OB1 rule table. Pure aside from a cached USER.md read. */
export function evaluateQuality(rec: QualityRecord): QualityVerdict {
  const { kind, name = "", frontmatter: fm = {}, body = "" } = rec;

  if (kind === "note" && PER_SERVICE_NOTE_RE.test(name)) {
    return { ok: false, reason: `per-service notification note: "${name}"`, suggestion: SUGGEST.perServiceNote };
  }

  if (kind === "matter") {
    const bodyLen = countBodyChars(body);
    const hasDomainKey = Object.prototype.hasOwnProperty.call(fm, "domain");
    if (/ Project$/.test(name) && bodyLen < 300 && hasDomainKey) {
      return { ok: false, reason: `domain-stub matter: "${name}" (body=${bodyLen} chars, has fm.domain)`, suggestion: SUGGEST.domainStubMatter };
    }
    if (String(fm.tier ?? "") === "inner_circle" && /Auto-generated/.test(body)) {
      return { ok: false, reason: `auto-generated inner_circle matter stub: "${name}"`, suggestion: SUGGEST.autoGenMatter };
    }
  }

  if (kind === "person") {
    if (NOTIFICATIONS_RE.test(name)) {
      return { ok: false, reason: `non-human person (Notifications): "${name}"`, suggestion: SUGGEST.nonHumanPerson };
    }
    if (name.includes("@")) {
      return { ok: false, reason: `non-human person (email-address as name): "${name}"`, suggestion: SUGGEST.nonHumanPerson };
    }
    const lower = name.toLowerCase();
    for (const tld of TLD_SUBSTRINGS) {
      if (lower.includes(tld)) {
        return { ok: false, reason: `non-human person (TLD in name): "${name}"`, suggestion: SUGGEST.nonHumanPerson };
      }
    }
    if (capitalisedTokenCount(name) < 2) {
      return { ok: false, reason: `non-human person (<2 capitalised tokens): "${name}"`, suggestion: SUGGEST.nonHumanPerson };
    }
  }

  if (kind === "org" && ORG_TLD_RE.test(name)) {
    const userMd = readUserMd(rec.vaultRoot).toLowerCase();
    if (!userMd.includes(name.toLowerCase())) {
      return { ok: false, reason: `domain-name org not in USER.md: "${name}"`, suggestion: SUGGEST.domainOrg };
    }
  }

  if (kind === "instinct") {
    const obs = Number(fm.observation_count ?? 0);
    const conf = Number(fm.confidence_score ?? 0);
    if (!Number.isNaN(obs) && !Number.isNaN(conf) && obs === 0 && conf >= 0.5) {
      return { ok: false, reason: `unearned instinct (observation_count=${obs}, confidence_score=${conf})`, suggestion: SUGGEST.unearnedInstinct };
    }
  }

  return { ok: true };
}

// In-memory rejection ring + accepted counter. Bounded so a runaway
// onboarding loop can't OOM ctrl-api.
export interface RejectionEntry {
  record_kind: string;
  name: string;
  reason: string;
  suggestion: string;
  timestamp: string;
}

const RING_CAP = 500;
const rejections: RejectionEntry[] = [];
let accepted = 0;

export function recordRejection(e: Omit<RejectionEntry, "timestamp"> & { timestamp?: string }): void {
  rejections.push({
    record_kind: e.record_kind,
    name: e.name,
    reason: e.reason,
    suggestion: e.suggestion,
    timestamp: e.timestamp ?? new Date().toISOString(),
  });
  if (rejections.length > RING_CAP) rejections.shift();
}

export function recordAcceptance(): void {
  accepted += 1;
}

export interface QualityReport {
  accepted: number;
  rejected_by_kind: Record<string, number>;
  rejections: RejectionEntry[];
  since: string;
}

/** Last-`windowMs` summary; window defaults to 24h. */
export function getQualityReport(windowMs: number = 24 * 60 * 60 * 1000): QualityReport {
  const cutoff = Date.now() - windowMs;
  const windowed: RejectionEntry[] = [];
  const byKind: Record<string, number> = {};
  for (const r of rejections) {
    if (Date.parse(r.timestamp) >= cutoff) {
      windowed.push(r);
      byKind[r.record_kind] = (byKind[r.record_kind] ?? 0) + 1;
    }
  }
  return {
    accepted,
    rejected_by_kind: byKind,
    rejections: windowed,
    since: new Date(cutoff).toISOString(),
  };
}
