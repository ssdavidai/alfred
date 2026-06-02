export type PaperclipComment = {
  id?: string;
  body?: string;
  comment?: string;
  text?: string;
  createdAt?: string;
  created_at?: string;
  actor?: unknown;
  author?: unknown;
};

export type PaperclipIssue = {
  id: string;
  identifier?: string;
  issueNumber?: number;
  title?: string;
  description?: string | null;
  status?: string;
  priority?: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  blocks?: Array<Partial<PaperclipIssue>>;
  blockedBy?: Array<Partial<PaperclipIssue>>;
  relatedWork?: {
    inbound?: Array<{ issue?: Partial<PaperclipIssue> }>;
    outbound?: Array<{ issue?: Partial<PaperclipIssue> }>;
  };
  referencedIssueIdentifiers?: string[];
  [key: string]: unknown;
};

export type GithubPull = {
  url: string;
  state: string;
  merged: boolean;
  mergeable?: boolean | null;
  headRef?: string;
  baseRef?: string;
  commits: Array<{ sha: string; url?: string; message?: string }>;
  files: Array<{ filename: string; status?: string; additions?: number; deletions?: number }>;
};

export type EvidencePacketInput = {
  issue: string;
  prUrl?: string;
  companyId?: string;
  paperclipOrigin?: string;
};

export type PaperclipEvidenceClient = {
  getIssue(issue: string, companyId?: string): Promise<PaperclipIssue>;
  listComments(issueId: string): Promise<PaperclipComment[]>;
};

export type GithubEvidenceClient = {
  getPull(prUrl: string): Promise<GithubPull>;
};

type EvidenceLine = { source: string; text: string };
type ReviewDecision = "approve" | "request_changes" | "block" | "unknown";

export type EvidencePacket = {
  issue: {
    id: string;
    identifier?: string;
    title?: string;
    status?: string;
    assignee?: string | null;
    url?: string;
  };
  linked_review_issues: Array<{
    id?: string;
    identifier?: string;
    title?: string;
    status?: string;
    url?: string;
    decision: ReviewDecision;
  }>;
  github_pr: null | GithubPull;
  evidence: EvidenceLine[];
  reviewer_decision: ReviewDecision;
  safe_to_mark_done: boolean;
  recommendation: string;
  warnings: string[];
  text: string;
};

const PR_RE = /https:\/\/github\.com\/([^\s/]+)\/([^\s/]+)\/pull\/(\d+)/i;
const CHECK_RE = /\b(test|tests|pytest|node --test|npm test|pnpm test|tsx --test|check|checks|ci|review|approved|request changes|blocked?)\b/i;

export function parseGithubPrUrl(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const m = text.match(PR_RE);
  return m?.[0];
}

export function parseGithubPrParts(prUrl: string): { owner: string; repo: string; number: number } {
  const m = prUrl.match(PR_RE);
  if (!m) throw new Error(`Invalid GitHub PR URL: ${prUrl}`);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

function commentText(comment: PaperclipComment): string {
  return String(comment.body ?? comment.comment ?? comment.text ?? "").trim();
}

function issueUrl(origin: string | undefined, issue: { id?: string; identifier?: string }): string | undefined {
  if (!origin) return undefined;
  const key = issue.identifier || issue.id;
  return key ? `${origin.replace(/\/$/, "")}/issues/${encodeURIComponent(key)}` : undefined;
}

function uniqueIssues(items: Array<Partial<PaperclipIssue> | undefined>): Array<Partial<PaperclipIssue>> {
  const seen = new Set<string>();
  const out: Array<Partial<PaperclipIssue>> = [];
  for (const item of items) {
    if (!item) continue;
    const key = String(item.id || item.identifier || item.issueNumber || item.title || "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function relatedReviewCandidates(issue: PaperclipIssue, comments: PaperclipComment[] = []): Array<Partial<PaperclipIssue>> {
  const related = [
    ...(issue.blocks || []),
    ...(issue.blockedBy || []),
    ...((issue.relatedWork?.inbound || []).map((r) => r.issue)),
    ...((issue.relatedWork?.outbound || []).map((r) => r.issue)),
  ];
  const reviewish = related.filter((r) => {
    const hay = `${r?.identifier || ""} ${r?.title || ""}`.toLowerCase();
    return hay.includes("review") || hay.includes("code reviewer");
  });
  const ownIdentifier = issue.identifier?.toUpperCase();
  const textRefs = `${issue.description || ""}\n${comments.map(commentText).join("\n")}`;
  const inferred = Array.from(textRefs.matchAll(/\b(ALFA-\d+)\b/gi))
    .map((m) => m[1].toUpperCase())
    .filter((identifier) => identifier !== ownIdentifier)
    .filter((identifier) => {
      const idx = textRefs.toUpperCase().indexOf(identifier);
      const window = textRefs.slice(Math.max(0, idx - 80), idx + identifier.length + 80).toLowerCase();
      return window.includes("review") || window.includes("approve") || window.includes("request") || window.includes("block");
    })
    .map((identifier) => ({ identifier }));
  return uniqueIssues([...reviewish, ...inferred]);
}

export function detectReviewDecision(lines: EvidenceLine[]): ReviewDecision {
  const text = lines.map((l) => l.text).join("\n").toLowerCase();
  const explicit = text.match(/\bdecision\s*:\s*(approve|approved|request[_ -]?changes|changes requested|block|blocked|reject|rejected)\b/);
  if (explicit) {
    const value = explicit[1];
    if (value.startsWith("approve")) return "approve";
    if (value.includes("request") || value.includes("changes")) return "request_changes";
    return "block";
  }
  if (/\b(request changes|changes requested|needs changes|revise)\b/.test(text)) return "request_changes";
  if (/\b(approve|approved|lgtm|looks good)\b/.test(text)) return "approve";
  if (/\b(blocked|blocking|reject|rejected)\b|\bdo not ship\b/.test(text)) return "block";
  return "unknown";
}

function collectEvidence(issue: PaperclipIssue, issueComments: PaperclipComment[], reviewComments: Array<{ issue: Partial<PaperclipIssue>; comments: PaperclipComment[] }>): EvidenceLine[] {
  const lines: EvidenceLine[] = [];
  const push = (source: string, text: string) => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return;
    lines.push({ source, text: clean.length > 240 ? `${clean.slice(0, 237)}...` : clean });
  };
  for (const c of issueComments) {
    const txt = commentText(c);
    if (CHECK_RE.test(txt)) push(issue.identifier || issue.id, txt);
  }
  for (const r of reviewComments) {
    const label = r.issue.identifier || r.issue.id || "review";
    for (const c of r.comments) {
      const txt = commentText(c);
      if (CHECK_RE.test(txt)) push(String(label), txt);
    }
  }
  return lines.slice(0, 12);
}

function render(packet: Omit<EvidencePacket, "text">): string {
  const pr = packet.github_pr;
  const prState = pr ? `${pr.merged ? "merged" : pr.state}${pr.merged ? "" : "/unmerged"}` : "missing";
  const commits = pr?.commits.slice(0, 5).map((c) => `${c.sha.slice(0, 7)}${c.url ? ` ${c.url}` : ""}`) || [];
  const files = pr?.files.slice(0, 12).map((f) => `${f.status || "changed"}: ${f.filename}`) || [];
  return [
    `Evidence packet: ${packet.issue.identifier || packet.issue.id} — ${packet.issue.title || "Untitled"}`,
    `Issue: ${packet.issue.status || "unknown"}${packet.issue.assignee ? `, assignee ${packet.issue.assignee}` : ""}${packet.issue.url ? `, ${packet.issue.url}` : ""}`,
    `PR: ${pr ? `${pr.url} (${prState}, branch ${pr.headRef || "unknown"})` : "missing"}`,
    packet.linked_review_issues.length
      ? `Review issues: ${packet.linked_review_issues.map((i) => `${i.identifier || i.id || "review"} ${i.status || "unknown"} decision=${i.decision}${i.url ? ` ${i.url}` : ""}`).join("; ")}`
      : "Review issues: none found",
    commits.length ? `Commits: ${commits.join("; ")}` : "Commits: none available",
    files.length ? `Changed files: ${files.join("; ")}` : "Changed files: none available",
    packet.evidence.length
      ? `Evidence: ${packet.evidence.map((e) => `[${e.source}] ${e.text}`).join(" | ")}`
      : "Evidence: none found in Paperclip comments",
    `Reviewer decision: ${packet.reviewer_decision}`,
    `Recommendation: ${packet.recommendation}`,
    packet.warnings.length ? `Warnings: ${packet.warnings.join("; ")}` : "Warnings: none",
  ].join("\n");
}

export async function generateEvidencePacket(input: EvidencePacketInput, clients: { paperclip: PaperclipEvidenceClient; github: GithubEvidenceClient }): Promise<EvidencePacket> {
  const issue = await clients.paperclip.getIssue(input.issue, input.companyId);
  const issueComments = await clients.paperclip.listComments(issue.id);
  const prUrl = input.prUrl || parseGithubPrUrl(issue.description || "") || parseGithubPrUrl(issueComments.map(commentText).join("\n"));

  const reviewCandidates = relatedReviewCandidates(issue, issueComments);
  const reviewComments = await Promise.all(
    reviewCandidates.map(async (candidate) => {
      const key = String(candidate.id || candidate.identifier || "");
      const full = key ? await clients.paperclip.getIssue(key, input.companyId).catch(() => candidate) : candidate;
      const comments = full.id ? await clients.paperclip.listComments(full.id).catch(() => []) : [];
      return { issue: full, comments };
    }),
  );

  const evidence = collectEvidence(issue, issueComments, reviewComments);
  const linked_review_issues = reviewComments.map((r) => {
    const decision = detectReviewDecision(r.comments.map((c) => ({ source: String(r.issue.identifier || r.issue.id || "review"), text: commentText(c) })));
    return {
      id: r.issue.id,
      identifier: r.issue.identifier,
      title: r.issue.title,
      status: r.issue.status,
      url: issueUrl(input.paperclipOrigin, r.issue),
      decision,
    };
  });
  const reviewer_decision = detectReviewDecision(evidence);

  let github_pr: GithubPull | null = null;
  const warnings: string[] = [];
  if (!prUrl) {
    warnings.push("missing PR");
  } else {
    github_pr = await clients.github.getPull(prUrl);
    if (github_pr.merged) warnings.push("PR is already merged");
    else if (github_pr.state === "open") warnings.push("PR is open/unmerged");
    else warnings.push(`PR is ${github_pr.state}/unmerged`);
  }
  if (!linked_review_issues.length) warnings.push("no linked review issue found");
  if (reviewer_decision === "unknown") warnings.push("no reviewer approval/request-changes/block decision found");
  if (!evidence.length) warnings.push("weak evidence: no checks/tests/review evidence found in comments");

  const safe_to_mark_done = Boolean(github_pr && github_pr.merged && reviewer_decision === "approve" && evidence.length > 0);
  const recommendation = safe_to_mark_done
    ? "Safe to mark done: merged PR, approving review decision, and comment evidence are present."
    : "Do not mark done without human confirmation: one or more required evidence gates are missing or still open.";

  const packetWithoutText = {
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      assignee: issue.assigneeAgentId || issue.assigneeUserId || null,
      url: issueUrl(input.paperclipOrigin, issue),
    },
    linked_review_issues,
    github_pr,
    evidence,
    reviewer_decision,
    safe_to_mark_done,
    recommendation,
    warnings,
  } satisfies Omit<EvidencePacket, "text">;

  return { ...packetWithoutText, text: render(packetWithoutText) };
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  const body = await res.text();
  let json: any = null;
  try { json = body ? JSON.parse(body) : null; } catch { json = body; }
  if (!res.ok) throw new Error(`GET ${url} failed ${res.status}: ${typeof json === "string" ? json.slice(0, 200) : JSON.stringify(json).slice(0, 200)}`);
  return json;
}

export function createGithubEvidenceClient(token = process.env.GITHUB_TOKEN): GithubEvidenceClient {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "alfred-evidence-packet" };
  if (token) headers.authorization = `Bearer ${token}`;
  return {
    async getPull(prUrl: string): Promise<GithubPull> {
      const { owner, repo, number } = parseGithubPrParts(prUrl);
      const base = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;
      const [pull, commitsRaw, filesRaw] = await Promise.all([
        fetchJson(base, { headers }),
        fetchJson(`${base}/commits?per_page=100`, { headers }),
        fetchJson(`${base}/files?per_page=100`, { headers }),
      ]);
      return {
        url: pull.html_url || prUrl,
        state: pull.state || "unknown",
        merged: Boolean(pull.merged),
        mergeable: pull.mergeable,
        headRef: pull.head?.ref,
        baseRef: pull.base?.ref,
        commits: Array.isArray(commitsRaw) ? commitsRaw.map((c: any) => ({ sha: c.sha, url: c.html_url, message: c.commit?.message })) : [],
        files: Array.isArray(filesRaw) ? filesRaw.map((f: any) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })) : [],
      };
    },
  };
}

export function createPaperclipEvidenceClient(opts: { baseUrl?: string; apiKey?: string } = {}): PaperclipEvidenceClient {
  const baseUrl = (opts.baseUrl || process.env.PAPERCLIP_BASE_URL || "http://paperclip:3100").replace(/\/$/, "");
  const apiKey = opts.apiKey || process.env.PAPERCLIP_API_KEY;
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const get = (path: string) => fetchJson(`${baseUrl}/api${path}`, { headers });
  const issuePath = (companyId: string | undefined, suffix = "") =>
    companyId
      ? `/companies/${encodeURIComponent(companyId)}/issues${suffix}`
      : `/issues${suffix}`;
  return {
    async getIssue(issue: string, companyId?: string): Promise<PaperclipIssue> {
      if (/^[0-9a-f-]{32,36}$/i.test(issue)) {
        return await get(issuePath(companyId, `/${encodeURIComponent(issue)}`));
      }
      const qs = new URLSearchParams({ q: issue });
      const listed = await get(`${issuePath(companyId)}?${qs.toString()}`);
      const arr = Array.isArray(listed) ? listed : listed.issues || listed.result || [];
      const found = arr.find((i: any) => i.identifier === issue || String(i.issueNumber) === issue || i.id === issue) || arr[0];
      if (!found) throw new Error(`Paperclip issue not found: ${issue}`);
      return found;
    },
    async listComments(issueId: string): Promise<PaperclipComment[]> {
      const qs = new URLSearchParams({ order: "desc", limit: "50" });
      const listed = await get(`/issues/${encodeURIComponent(issueId)}/comments?${qs.toString()}`);
      return Array.isArray(listed) ? listed : listed.comments || listed.result || [];
    },
  };
}
