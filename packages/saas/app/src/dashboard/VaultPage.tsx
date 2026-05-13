// VaultPage — three-pane Obsidian view (#858).
//
// Tree (left)   — getVaultGraph nodes grouped client-side by FAMILY_OF
// Reader (mid)  — getVaultRecord body with the Markdown component
//                 (which already wires getVaultTitleIndex for live wikilinks)
// Backlinks (R) — derived from getVaultGraph edges where target == current
//
// Editing uses createVaultRecord for the same path (the existing endpoint
// upserts on POST). For minimal lift this commit ships the read view fully
// wired, with edit-mode falling through createVaultRecord. The "create new"
// affordance lives in a small button that opens a dialog asking for type +
// name + initial body.
//
// State-field edits on matter/* and task/* records (Phase F · #894) are
// special-cased: when the principal touches a declared state field the
// save splits into two writes — a POST /state-changes envelope through
// applyManualStateChange (with optional reason + as_of fence) AND a legacy
// PATCH (via createVaultRecord upsert) for the body + any non-state
// frontmatter edits. The state writer keeps an audit trail; the body
// writer doesn't. On 409 (as_of mismatch) the editor shows a Reload /
// Force-Write dialog per spec §10.
//
// URL state: ?slug=<vault path without .md> — bookmarkable. The redirects
// from /dashboard/vault and /dashboard/vault/* point here.
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  useQuery,
  getVaultGraph,
  getVaultRecord,
  createVaultRecord,
  applyManualStateChange,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import { Markdown } from "../client/components/ab/Markdown";

// Mirror of `packages/ctrl/src/api/stateFields.ts` — every key here
// requires a state-change envelope (POST /api/v1/state-changes) rather
// than the legacy PATCH. Keep in sync with ctrl-api on every schema bump.
const MATTER_STATE_FIELDS = [
  "current_state",
  "as_of",
  "status",
  "surface_class",
  "last_briefing_at",
] as const;

const TASK_STATE_FIELDS = [
  "current_state",
  "as_of",
  "status",
  "outcome",
  "pending_confirmation",
  "last_steward_outcome",
] as const;

function stateFieldsForPath(path: string): readonly string[] | null {
  const norm = path.replace(/\\/g, "/");
  if (norm.startsWith("matter/") && norm.endsWith(".md")) return MATTER_STATE_FIELDS;
  if (norm.startsWith("task/") && norm.endsWith(".md")) return TASK_STATE_FIELDS;
  return null;
}

// Map our lower-case vault types to the redesign's four families.
const FAMILY_OF: Record<string, "Standing" | "Activity" | "Learning" | "Intuition"> = {
  // Standing
  person: "Standing",
  org: "Standing",
  project: "Standing",
  location: "Standing",
  matter: "Standing",
  account: "Standing",
  asset: "Standing",
  process: "Standing",
  // Activity
  conversation: "Activity",
  note: "Activity",
  task: "Activity",
  triage: "Activity",
  event: "Activity",
  session: "Activity",
  input: "Activity",
  run: "Activity",
  ledger_entry: "Activity",
  signal: "Activity",
  needs_attention: "Activity",
  stream_event: "Activity",
  chore: "Activity",
  // Learning
  assumption: "Learning",
  decision: "Learning",
  constraint: "Learning",
  contradiction: "Learning",
  synthesis: "Learning",
  // Intuition
  observation: "Intuition",
  instinct: "Intuition",
  reflection: "Intuition",
  pattern_proposal: "Intuition",
};

const FAMILY_ORDER = ["Standing", "Activity", "Learning", "Intuition"] as const;
type Family = (typeof FAMILY_ORDER)[number];

interface GraphNode {
  id: string;     // vault path, e.g. "matter/carter.md"
  type: string;
  name: string;
  status: string;
}

interface GraphEdge {
  source: string;
  target: string;
  relation: string;
}

function slugFromPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\.md$/, "");
}

function pathFromSlug(slug: string): string {
  return slug.endsWith(".md") ? slug : `${slug}.md`;
}

export default function VaultPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const initialSlug = searchParams.get("slug") ?? "";

  const { data: graphData, isLoading: graphLoading } = useQuery(getVaultGraph);
  const nodes: GraphNode[] = Array.isArray(graphData?.nodes) ? graphData?.nodes : [];
  const edges: GraphEdge[] = Array.isArray(graphData?.edges) ? graphData?.edges : [];

  const [selectedSlug, setSelectedSlug] = useState<string>(initialSlug);

  // Default selection: first node alphabetically on first load if none picked.
  useEffect(() => {
    if (selectedSlug || nodes.length === 0) return;
    const sorted = [...nodes].sort((a, b) => a.name.localeCompare(b.name));
    setSelectedSlug(slugFromPath(sorted[0].id));
  }, [nodes, selectedSlug]);

  // Sync ?slug= on selection.
  useEffect(() => {
    if (selectedSlug && initialSlug !== selectedSlug) {
      setSearchParams({ slug: selectedSlug }, { replace: true });
    }
  }, [selectedSlug, initialSlug, setSearchParams]);

  // Tree state.
  const [openFamily, setOpenFamily] = useState<Record<Family, boolean>>({
    Standing: true,
    Activity: false,
    Learning: false,
    Intuition: false,
  });
  const [openType, setOpenType] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");

  // Reader / editor state.
  const selectedPath = useMemo(
    () => (selectedSlug ? pathFromSlug(selectedSlug) : ""),
    [selectedSlug],
  );
  const { data: recordData, isLoading: recordLoading } = useQuery(
    getVaultRecord,
    { path: selectedPath },
    { enabled: Boolean(selectedPath) },
  );
  const body = String(recordData?.body ?? "");
  const fm = (recordData?.frontmatter ?? {}) as Record<string, unknown>;

  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const [saving, setSaving] = useState(false);

  // ---- State-field editing (Phase F · #894) ----------------------------
  // When the open record is matter/* or task/*, the editor exposes a
  // small panel above the body textarea letting the principal change the
  // declared state fields directly. Each input is wired to a draft
  // object keyed by field name; the diff against `mountedFm` decides
  // whether to dispatch a state-change envelope on save.
  const stateAllow = useMemo(
    () => (selectedPath ? stateFieldsForPath(selectedPath) : null),
    [selectedPath],
  );
  // The `fm` snapshot the editor mounted with — used for as_of fencing
  // and for diffing state-field changes. Re-captured each time the user
  // hits Edit so re-opening picks up server-side updates.
  const [mountedFm, setMountedFm] = useState<Record<string, unknown>>({});
  const [stateDraft, setStateDraft] = useState<Record<string, string>>({});
  const [reasonDraft, setReasonDraft] = useState("");
  // Phase F UX state — set when applyManualStateChange returns 409.
  const [conflict, setConflict] = useState<null | { message: string }>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Backlinks (records pointing to selectedPath).
  const backlinks = useMemo(() => {
    if (!selectedPath) return [] as GraphNode[];
    const pointers = edges.filter((e) => e.target === selectedPath);
    const sourceIds = new Set(pointers.map((e) => e.source));
    return nodes.filter((n) => sourceIds.has(n.id));
  }, [edges, nodes, selectedPath]);

  const groupedBacklinks = useMemo(() => {
    const g: Record<string, GraphNode[]> = {};
    for (const b of backlinks) {
      (g[b.type] ??= []).push(b);
    }
    return g;
  }, [backlinks]);

  // Tree grouping.
  const tree = useMemo(() => {
    const out: Record<Family, Record<string, GraphNode[]>> = {
      Standing: {},
      Activity: {},
      Learning: {},
      Intuition: {},
    };
    for (const n of nodes) {
      const fam = FAMILY_OF[n.type] ?? "Activity";
      (out[fam][n.type] ??= []).push(n);
    }
    for (const fam of FAMILY_ORDER) {
      for (const t of Object.keys(out[fam])) {
        out[fam][t].sort((a, b) => a.name.localeCompare(b.name));
      }
    }
    return out;
  }, [nodes]);

  const q = query.trim().toLowerCase();
  const matches = (n: GraphNode) =>
    !q ||
    n.name.toLowerCase().includes(q) ||
    n.id.toLowerCase().includes(q) ||
    n.type.toLowerCase().includes(q);

  function selectRecord(slug: string) {
    setSelectedSlug(slug);
    setEditing(false);
  }

  function beginEdit() {
    setEditDraft(body);
    setEditing(true);
    // Snapshot the frontmatter we mounted with for as_of fencing + diff.
    setMountedFm({ ...fm });
    if (stateAllow) {
      const initial: Record<string, string> = {};
      for (const f of stateAllow) {
        const v = fm[f];
        if (v === undefined || v === null) {
          initial[f] = "";
        } else if (typeof v === "string") {
          initial[f] = v;
        } else {
          initial[f] = String(v);
        }
      }
      setStateDraft(initial);
    } else {
      setStateDraft({});
    }
    setReasonDraft("");
    setConflict(null);
    setSaveError(null);
  }

  function cancelEdit() {
    setEditing(false);
    setEditDraft("");
    setStateDraft({});
    setReasonDraft("");
    setConflict(null);
    setSaveError(null);
  }

  // Diff the state-field draft against the mounted frontmatter. Returns
  // an object with only the changed state fields, or null if none touched.
  function diffStateFields(): Record<string, string> | null {
    if (!stateAllow) return null;
    const out: Record<string, string> = {};
    for (const f of stateAllow) {
      const cur = stateDraft[f] ?? "";
      const prior = mountedFm[f];
      const priorStr =
        prior === undefined || prior === null
          ? ""
          : typeof prior === "string"
            ? prior
            : String(prior);
      if (cur !== priorStr) {
        out[f] = cur;
      }
    }
    return Object.keys(out).length ? out : null;
  }

  // Build the file content (frontmatter + body) for the legacy PATCH
  // path. Frontmatter is recomposed from the mounted fm so the legacy
  // write doesn't stomp state fields touched by the state-change envelope.
  function buildContent(fmForFile: Record<string, unknown>): string {
    const fmLines = ["---"];
    for (const [k, v] of Object.entries(fmForFile)) {
      if (Array.isArray(v)) {
        fmLines.push(`${k}: [${v.map((x) => JSON.stringify(x)).join(", ")}]`);
      } else if (typeof v === "string") {
        fmLines.push(`${k}: ${v}`);
      } else {
        fmLines.push(`${k}: ${JSON.stringify(v)}`);
      }
    }
    fmLines.push("---", "");
    return `${fmLines.join("\n")}\n${editDraft}`;
  }

  async function saveEdit(opts?: { forceWrite?: boolean }) {
    if (!selectedSlug) return;
    setSaving(true);
    setSaveError(null);
    try {
      const stateDiff = diffStateFields();
      const type = String(fm.type ?? selectedSlug.split("/")[0] ?? "note");

      if (stateDiff) {
        // Phase F · #894 — route state-field edits through the
        // state-change envelope. The applyManualStateChange action
        // attaches source=manual.<userId>, confidence=1.0, mode=live,
        // and forwards to POST /api/v1/state-changes.
        const mountedAsOf =
          typeof mountedFm.as_of === "string" ? (mountedFm.as_of as string) : null;
        try {
          await applyManualStateChange({
            target_path: selectedPath,
            fields: stateDiff,
            // Force-write skips the optimistic-concurrency fence by
            // omitting expected_as_of. Reload abandons the change set
            // entirely so this branch is the only place force-write
            // can fire from.
            expected_as_of: opts?.forceWrite ? null : mountedAsOf,
            reason: reasonDraft,
          });
        } catch (err: any) {
          const status = err?.statusCode ?? err?.status ?? null;
          const msg = String(err?.message ?? "");
          if (status === 409 || /\bas_of mismatch\b/i.test(msg) || /\bconflict\b/i.test(msg)) {
            // The record moved under our feet — defer to the conflict UI.
            setConflict({
              message:
                "This record was updated by another writer while you were " +
                "editing. Reload to discard your changes, or Force write to " +
                "apply them anyway.",
            });
            setSaving(false);
            return;
          }
          throw err;
        }
      }

      // Legacy PATCH (createVaultRecord upsert) for the body + any
      // non-state-field tweaks. If the only change was a state field we
      // still want to persist the body (it's currently identical, so
      // this is a no-op write but keeps the contract simple). If there's
      // nothing to write, short-circuit.
      const bodyChanged = editDraft !== body;
      if (bodyChanged || !stateDiff) {
        // Recompose the frontmatter from mountedFm so we never re-PATCH
        // a state field through the legacy endpoint. State fields landed
        // (if any) via the state-change envelope above; ctrl-api has
        // already bumped as_of on disk so a re-read on the next load
        // will reflect the new state.
        const content = buildContent(mountedFm);
        await createVaultRecord({
          type,
          name: selectedPath,
          content,
        });
      }
      setEditing(false);
      setEditDraft("");
      setStateDraft({});
      setReasonDraft("");
      setConflict(null);
    } catch (e: any) {
      console.error("save failed", e);
      setSaveError(String(e?.message ?? "Save failed"));
    } finally {
      setSaving(false);
    }
  }

  async function conflictReload() {
    // Drop local edits + close the editor; the next render re-reads
    // getVaultRecord via useQuery and the user can re-Edit with the
    // fresh as_of.
    setConflict(null);
    setEditing(false);
    setEditDraft("");
    setStateDraft({});
    setReasonDraft("");
    setSaveError(null);
  }

  async function conflictForceWrite() {
    // Re-submit ignoring local state-conflict (no expected_as_of fence).
    setConflict(null);
    await saveEdit({ forceWrite: true });
  }

  // Create-new dialog.
  const [creating, setCreating] = useState(false);
  const [newType, setNewType] = useState("note");
  const [newName, setNewName] = useState("");

  async function createNew() {
    if (!newName.trim()) return;
    try {
      const slug = newName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      await createVaultRecord({
        type: newType,
        name: `${newType}/${slug}.md`,
        description: "",
      });
      setCreating(false);
      setSelectedSlug(`${newType}/${slug}`);
      setNewName("");
    } catch (e) {
      console.error("create failed", e);
    }
  }

  return (
    <Frame>
      <section className="mx-auto max-w-[1280px] px-8 py-10">
        <div className="flex items-baseline justify-between mb-6">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.28em]"
            style={{ color: "var(--brass)" }}
          >
            Vault
          </div>
          <button
            onClick={() => setCreating(true)}
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--brass)" }}
          >
            + New record
          </button>
        </div>

        {creating && (
          <div className="border border-rule p-4 mb-4 grid grid-cols-[140px_1fr_auto_auto] gap-3 items-baseline">
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              className="bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
            >
              {Object.keys(FAMILY_OF).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Record name"
              className="bg-transparent border border-rule px-3 py-1 font-body text-[14px]"
            />
            <button onClick={createNew} className="btn-brass" style={{ fontSize: "0.9rem" }}>
              Create
            </button>
            <button
              onClick={() => {
                setCreating(false);
                setNewName("");
              }}
              className="btn-ghost"
            >
              Cancel
            </button>
          </div>
        )}

        <div className="grid grid-cols-[280px_1fr_280px] gap-8 border-t border-rule pt-6 min-h-[640px]">
          {/* Left — search + tree */}
          <aside className="border-r border-rule pr-4 overflow-auto" style={{ maxHeight: "75vh" }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the vault…"
              className="w-full bg-transparent border border-rule px-3 py-2 mb-4 font-body text-[14px] outline-none"
              style={{ borderColor: "var(--rule)" }}
            />
            {graphLoading && (
              <p
                className="font-body italic text-[14px]"
                style={{ color: "var(--marginalia)" }}
              >
                Reading the index…
              </p>
            )}
            {FAMILY_ORDER.map((fam) => {
              const types = tree[fam];
              const total = Object.values(types).reduce(
                (s, arr) => s + arr.filter(matches).length,
                0,
              );
              if (q && total === 0) return null;
              if (Object.keys(types).length === 0) return null;
              const isFamOpen = openFamily[fam] || Boolean(q);
              return (
                <div key={fam} className="mb-4">
                  <button
                    onClick={() =>
                      setOpenFamily((s) => ({ ...s, [fam]: !s[fam] }))
                    }
                    className="w-full text-left flex items-baseline gap-2 py-1"
                  >
                    <span
                      className="font-mono text-[10px] w-3"
                      style={{ color: "var(--brass)" }}
                    >
                      {isFamOpen ? "▾" : "▸"}
                    </span>
                    <span className="font-display italic text-[18px]">{fam}</span>
                    <span
                      className="font-mono text-[10px] ml-auto"
                      style={{ color: "var(--marginalia)" }}
                    >
                      {total}
                    </span>
                  </button>
                  {isFamOpen && (
                    <ul className="mt-1">
                      {Object.entries(types).map(([type, recs]) => {
                        const filtered = recs.filter(matches);
                        if (filtered.length === 0) return null;
                        const tkey = `${fam}::${type}`;
                        const isTypeOpen = openType[tkey] || Boolean(q);
                        return (
                          <li key={type} className="mb-1">
                            <button
                              onClick={() =>
                                setOpenType((s) => ({ ...s, [tkey]: !s[tkey] }))
                              }
                              className="w-full text-left flex items-baseline gap-2 py-1 pl-5"
                            >
                              <span
                                className="font-mono text-[10px] w-3"
                                style={{ color: "var(--marginalia)" }}
                              >
                                {isTypeOpen ? "▾" : "▸"}
                              </span>
                              <span
                                className="font-mono text-[10px] uppercase tracking-[0.22em]"
                                style={{ color: "var(--marginalia)" }}
                              >
                                {type}
                              </span>
                              <span
                                className="font-mono text-[10px] ml-auto"
                                style={{ color: "var(--marginalia)" }}
                              >
                                {filtered.length}
                              </span>
                            </button>
                            {isTypeOpen && (
                              <ul>
                                {filtered.map((rec) => {
                                  const slug = slugFromPath(rec.id);
                                  const sel = slug === selectedSlug;
                                  return (
                                    <li key={rec.id}>
                                      <button
                                        onClick={() => selectRecord(slug)}
                                        className="text-left w-full font-body text-[14px] py-1 pl-10"
                                        style={{
                                          color: "var(--ink)",
                                          opacity: sel ? 1 : 0.75,
                                          borderLeft: sel
                                            ? "1px solid var(--brass)"
                                            : "1px solid transparent",
                                          marginLeft: -1,
                                        }}
                                      >
                                        {rec.name}
                                      </button>
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </aside>

          {/* Centre — reader / editor */}
          <article className="px-2 overflow-auto" style={{ maxHeight: "75vh" }}>
            <div className="flex items-center justify-between mb-4">
              <details className="border border-rule p-3 font-mono text-[11px] flex-1 mr-3">
                <summary
                  className="cursor-pointer uppercase tracking-[0.22em] text-[10px]"
                  style={{ color: "var(--marginalia)" }}
                >
                  Details
                </summary>
                <div className="grid grid-cols-[80px_1fr] gap-y-1 mt-3">
                  <span style={{ color: "var(--marginalia)" }}>type:</span>
                  <span style={{ color: "var(--brass)" }}>
                    {String(fm.type ?? "—")}
                    {fm.type ? (
                      <span style={{ color: "var(--marginalia)" }}>
                        {" "}· {FAMILY_OF[String(fm.type)] ?? "Activity"}
                      </span>
                    ) : null}
                  </span>
                  <span style={{ color: "var(--marginalia)" }}>created:</span>
                  <span>{String(fm.created ?? "—")}</span>
                  <span style={{ color: "var(--marginalia)" }}>status:</span>
                  <span>{String(fm.status ?? "—")}</span>
                  {Array.isArray(fm.tags) && fm.tags.length > 0 && (
                    <>
                      <span style={{ color: "var(--marginalia)" }}>tags:</span>
                      <span>
                        {(fm.tags as string[]).map((t) => `#${t}`).join("  ")}
                      </span>
                    </>
                  )}
                  <span style={{ color: "var(--marginalia)" }}>slug:</span>
                  <span style={{ color: "var(--marginalia)" }}>{selectedSlug || "—"}</span>
                </div>
              </details>
              {!editing ? (
                <button onClick={beginEdit} className="btn-ghost" disabled={!selectedPath}>
                  Edit
                </button>
              ) : (
                <div className="flex gap-2">
                  <button
                    onClick={() => saveEdit()}
                    className="btn-brass"
                    disabled={saving}
                  >
                    {saving ? "…" : "Save"}
                  </button>
                  <button onClick={cancelEdit} className="btn-ghost" disabled={saving}>
                    Cancel
                  </button>
                </div>
              )}
            </div>

            {recordLoading ? (
              <p
                className="font-body italic text-[14px]"
                style={{ color: "var(--marginalia)" }}
              >
                Reading the file…
              </p>
            ) : editing ? (
              <div className="space-y-4">
                {stateAllow && (
                  <div
                    className="border border-rule p-3"
                    style={{ borderColor: "var(--rule)" }}
                  >
                    <div
                      className="font-mono text-[10px] uppercase tracking-[0.22em] mb-3"
                      style={{ color: "var(--brass)" }}
                    >
                      State fields
                      <span
                        className="ml-2 font-mono text-[9px] normal-case tracking-normal"
                        style={{ color: "var(--marginalia)" }}
                      >
                        (audited via state-change envelope)
                      </span>
                    </div>
                    <div className="grid grid-cols-[140px_1fr] gap-2 items-baseline">
                      {stateAllow.map((f) => {
                        const cur = stateDraft[f] ?? "";
                        const useTextarea = f === "current_state";
                        return (
                          <React.Fragment key={f}>
                            <label
                              className="font-mono text-[11px]"
                              style={{ color: "var(--marginalia)" }}
                            >
                              {f}
                            </label>
                            {useTextarea ? (
                              <textarea
                                value={cur}
                                onChange={(e) =>
                                  setStateDraft((s) => ({ ...s, [f]: e.target.value }))
                                }
                                rows={4}
                                className="bg-transparent border border-rule p-2 font-mono text-[12px] outline-none leading-[1.4]"
                              />
                            ) : (
                              <input
                                value={cur}
                                onChange={(e) =>
                                  setStateDraft((s) => ({ ...s, [f]: e.target.value }))
                                }
                                className="bg-transparent border border-rule px-2 py-1 font-mono text-[12px] outline-none"
                              />
                            )}
                          </React.Fragment>
                        );
                      })}
                    </div>
                    {diffStateFields() && (
                      <div className="mt-3">
                        <label
                          className="font-mono text-[10px] uppercase tracking-[0.22em] block mb-1"
                          style={{ color: "var(--marginalia)" }}
                        >
                          Why are you changing this?
                        </label>
                        <textarea
                          value={reasonDraft}
                          onChange={(e) => setReasonDraft(e.target.value)}
                          rows={2}
                          placeholder="Optional — defaults to 'Manual edit — no reason given'"
                          className="w-full bg-transparent border border-rule px-2 py-1 font-body text-[13px] outline-none"
                        />
                      </div>
                    )}
                  </div>
                )}
                {saveError && (
                  <p
                    className="font-mono text-[11px]"
                    style={{ color: "var(--brass)" }}
                  >
                    {saveError}
                  </p>
                )}
                <textarea
                  autoFocus
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  className="w-full min-h-[440px] bg-transparent border border-rule p-4 font-mono text-[13px] outline-none leading-[1.55]"
                  style={{ borderColor: "var(--brass)" }}
                />
              </div>
            ) : (
              <Markdown
                source={body}
                onLink={(title) => {
                  // Find by name match.
                  const byName = nodes.find(
                    (n) => n.name.toLowerCase() === title.toLowerCase(),
                  );
                  if (byName) {
                    selectRecord(slugFromPath(byName.id));
                    return;
                  }
                  // The default getVaultTitleIndex resolver will route via
                  // navigate() if available; explicit fallback to /vault.
                  navigate(`/vault?slug=${encodeURIComponent(title)}`);
                }}
              />
            )}
          </article>

          {/* Right — backlinks */}
          <aside className="border-l border-rule pl-5 overflow-auto" style={{ maxHeight: "75vh" }}>
            <div
              className="font-mono text-[10px] uppercase tracking-[0.22em] mb-4"
              style={{ color: "var(--brass)" }}
            >
              Linked from
            </div>
            {backlinks.length === 0 ? (
              <p
                className="font-body italic text-[14px]"
                style={{ color: "var(--marginalia)" }}
              >
                No record yet links here.
              </p>
            ) : (
              <div className="space-y-5">
                {Object.entries(groupedBacklinks).map(([type, recs]) => (
                  <div key={type}>
                    <div
                      className="font-mono text-[10px] uppercase tracking-[0.22em] mb-1"
                      style={{ color: "var(--marginalia)" }}
                    >
                      {type}
                    </div>
                    <ul>
                      {recs.map((r) => (
                        <li key={r.id}>
                          <button
                            onClick={() => selectRecord(slugFromPath(r.id))}
                            className="text-left font-display italic text-[15px] py-1 hover:underline underline-offset-4"
                            style={{ color: "var(--ink)" }}
                          >
                            {r.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </aside>
        </div>

        {/* Phase F · #894 — as_of conflict dialog. Fires when ctrl-api
            rejects applyManualStateChange with 409 because another writer
            bumped the matter/task while the editor was open. */}
        {conflict && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center"
            style={{ background: "rgba(0, 0, 0, 0.55)" }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="vault-conflict-title"
          >
            <div
              className="border border-rule p-6 max-w-[480px] w-full"
              style={{ background: "var(--paper)", borderColor: "var(--brass)" }}
            >
              <div
                id="vault-conflict-title"
                className="font-mono text-[10px] uppercase tracking-[0.28em] mb-3"
                style={{ color: "var(--brass)" }}
              >
                Concurrent edit
              </div>
              <p
                className="font-body text-[14px] leading-[1.55] mb-5"
                style={{ color: "var(--ink)" }}
              >
                {conflict.message}
              </p>
              <div className="flex gap-3 justify-end">
                <button
                  onClick={conflictReload}
                  className="btn-ghost"
                  disabled={saving}
                >
                  Reload
                </button>
                <button
                  onClick={conflictForceWrite}
                  className="btn-brass"
                  disabled={saving}
                >
                  {saving ? "…" : "Force write"}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </Frame>
  );
}
