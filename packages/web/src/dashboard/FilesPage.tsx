// FilesPage — principal-facing blob store (#114 PR3).
//
// What this page is
// -----------------
// /files is the principal's raw storage surface — PDFs the accountant
// sends, screenshots the household drops in, archive ZIPs, the odd MP3.
// Vault is for markdown the principal reads and edits; /files is for
// blobs Alfred can read but the principal owns. Distinct vocabulary,
// distinct page. Backed by the `files_data` named volume + the ctrl-api
// /api/v1/files/* surface shipped in PR1 and PATCH-extended in PR2.
//
// Layout (matches VaultPage's letterpress idiom):
//
//   ┌─ Frame ────────────────────────────────────────────────────────┐
//   │  Files                                       + Upload          │
//   │  [────── quota strip ──────]                                    │
//   │  ┌──────────┬─────────────────────────┬─────────────────────┐   │
//   │  │  tree    │   list (drop zone)      │   preview pane      │   │
//   │  │  search  │                         │   stat + body       │   │
//   │  └──────────┴─────────────────────────┴─────────────────────┘   │
//   └────────────────────────────────────────────────────────────────┘
//
// Logic in FilesPageCore.ts is tested independently; this file is the
// UI shell + the side-effect plumbing (uploads, blob preview fetches,
// optimistic label edits).
import { useEffect, useMemo, useRef, useState } from "react";
import { config } from "wasp/client";
import {
  useQuery,
  useAction,
  getFilesUsage,
  getFilesList,
  getFileStat,
  updateFileLabel,
  deleteFile,
  listDeletedFiles,
  restoreFile,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import {
  badgeLabel,
  buildPrefixTree,
  deriveBadgeState,
  deriveQuotaView,
  derivePreviewMode,
  formatBytes,
  formatUploadedAt,
  labelDraftFor,
  makeDebounceController,
  reduceLabelEdit,
  shortSha,
  shouldRejectUpload,
  uploadPercent,
  type BadgeState,
  type FileRow,
  type FilesUsage,
  type LabelEditState,
  type PreviewMode,
  type UploadItem,
} from "./FilesPageCore";

// ── localStorage session token (mirrors ChatWidget / TerminalPage) ──────────

function getWaspSessionId(): string | null {
  try {
    const raw = localStorage.getItem("wasp:sessionId");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Wasp server base — the SPA host and the api. host differ. */
function apiBase(): string {
  return (config.apiUrl ?? "").replace(/\/$/, "");
}

/** Build a `/api/files/blob/...` URL for the preview pane. The browser
 *  attaches the session via `?token=` since <img>/<iframe> can't carry
 *  an Authorization header. */
function blobUrl(path: string): string {
  const token = getWaspSessionId();
  const enc = path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  const base = `${apiBase()}/api/files/blob/${enc}`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

// ── upload helper ──────────────────────────────────────────────────────────

interface UploadCallbacks {
  onProgress: (loaded: number) => void;
  onDone: (path: string) => void;
  onError: (status: number, message: string) => void;
}

/** Native XHR for the multipart upload — `fetch` doesn't surface upload
 *  progress events, and the principal expects a live progress bar on a
 *  2 GB PDF. The body is a FormData with one `file` part + optional
 *  text fields. */
function uploadFile(file: File, callbacks: UploadCallbacks): XMLHttpRequest {
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `${apiBase()}/api/files/upload`);
  const token = getWaspSessionId();
  if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);

  xhr.upload.addEventListener("progress", (e) => {
    if (e.lengthComputable) callbacks.onProgress(e.loaded);
  });

  xhr.addEventListener("load", () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        const body = JSON.parse(xhr.responseText);
        callbacks.onDone(String(body.path ?? ""));
      } catch {
        callbacks.onError(xhr.status, "Server response was not JSON");
      }
    } else {
      let message = xhr.statusText || `HTTP ${xhr.status}`;
      try {
        const body = JSON.parse(xhr.responseText);
        if (typeof body?.message === "string") message = body.message;
        else if (typeof body?.error === "string") message = body.error;
      } catch {
        /* keep statusText fallback */
      }
      callbacks.onError(xhr.status, message);
    }
  });

  xhr.addEventListener("error", () => {
    callbacks.onError(0, "Network error");
  });

  const fd = new FormData();
  fd.append("file", file);
  fd.append("original_filename", file.name);
  xhr.send(fd);
  return xhr;
}

// ── tiny toast helper (this file's only side-effect surface) ────────────────
//
// We don't pull in a toast library; the existing `useToast` hook on
// DeskPage requires Wasp's Toaster setup which isn't mounted on every
// page. For /files we render a small banner at the bottom-right.

interface Banner {
  id: number;
  tone: "error" | "info" | "success";
  text: string;
}

// ── label edit map (one state per row) ─────────────────────────────────────

type LabelEditMap = Record<string, LabelEditState>;

// ── page ───────────────────────────────────────────────────────────────────

export default function FilesPage() {
  // Quota + list state. Refetch interval is generous (every 30s) because
  // /usage is cheap (one SQL aggregate) and the page is editorial, not
  // dashboardy — the strip just needs to be roughly correct.
  const {
    data: usageData,
    refetch: refetchUsage,
  } = useQuery(getFilesUsage, undefined, { retry: false });

  // Search + prefix filter. `appliedQuery` is the value actually sent to
  // the server (debounced); `pendingQuery` is what's in the input box.
  const [pendingQuery, setPendingQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [activePrefix, setActivePrefix] = useState("");

  const {
    data: listData,
    refetch: refetchList,
    isFetching: listFetching,
  } = useQuery(
    getFilesList,
    { q: appliedQuery, prefix: activePrefix, limit: 200 },
    { retry: false },
  );

  // Debounce the search box. 300ms cooldown — the controller lives for
  // the lifetime of the page; the effect rewires onEmit each render so
  // the latest `setAppliedQuery` reference is used.
  const debounceRef = useRef<ReturnType<typeof makeDebounceController> | null>(
    null,
  );
  if (!debounceRef.current) {
    debounceRef.current = makeDebounceController(300, (v) =>
      setAppliedQuery(v),
    );
  }
  useEffect(() => {
    return () => debounceRef.current?.cancel();
  }, []);

  function onSearchChange(value: string) {
    setPendingQuery(value);
    debounceRef.current?.push(value);
  }

  // List rows + tree.
  const rows: FileRow[] = useMemo(() => {
    const items = (listData as any)?.items;
    return Array.isArray(items) ? (items as FileRow[]) : [];
  }, [listData]);

  const tree = useMemo(() => buildPrefixTree(rows), [rows]);

  // Selection.
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const selectedRow = useMemo(
    () => rows.find((r) => r.path === selectedPath) ?? null,
    [rows, selectedPath],
  );

  // When the row list refreshes, drop selection if it disappeared.
  useEffect(() => {
    if (selectedPath && !rows.some((r) => r.path === selectedPath)) {
      setSelectedPath(null);
    }
  }, [rows, selectedPath]);

  // Stat for the selected row — drives the side-panel detail strip.
  const { data: statData } = useQuery(
    getFileStat,
    { path: selectedPath ?? "" },
    { enabled: Boolean(selectedPath), retry: false },
  );

  // Label edit map — one entry per row currently being edited.
  const [labelEdits, setLabelEdits] = useState<LabelEditMap>({});
  const labelEditAction = useAction(updateFileLabel);

  function beginLabelEdit(row: FileRow) {
    // Seed from the row's current canonical value — any prior edit state
    // for this row is intentionally discarded (the reducer treats begin
    // as an unconditional fresh start).
    setLabelEdits((m) => ({
      ...m,
      [row.path]: reduceLabelEdit(
        { kind: "idle", value: row.principal_label },
        { type: "begin" },
      ),
    }));
  }

  function updateLabelDraft(path: string, draft: string) {
    setLabelEdits((m) => {
      const cur = m[path];
      if (!cur) return m;
      return { ...m, [path]: reduceLabelEdit(cur, { type: "change", draft }) };
    });
  }

  function cancelLabelEdit(path: string) {
    setLabelEdits((m) => {
      const cur = m[path];
      if (!cur) return m;
      return { ...m, [path]: reduceLabelEdit(cur, { type: "cancel" }) };
    });
  }

  async function commitLabelEdit(path: string) {
    const cur = labelEdits[path];
    if (!cur || cur.kind !== "editing") return;
    const draft = cur.draft;
    setLabelEdits((m) => ({
      ...m,
      [path]: reduceLabelEdit(cur, { type: "commit" }),
    }));
    try {
      const next = await labelEditAction({
        path,
        principal_label: draft.trim() === "" ? null : draft.trim(),
      });
      setLabelEdits((m) => {
        const cur2 = m[path];
        if (!cur2) return m;
        return {
          ...m,
          [path]: reduceLabelEdit(cur2, {
            type: "saved",
            value: (next as FileRow).principal_label,
          }),
        };
      });
      // Refetch list so the canonical row reflects the new label.
      refetchList();
    } catch (err: any) {
      setLabelEdits((m) => {
        const cur2 = m[path];
        if (!cur2) return m;
        return {
          ...m,
          [path]: reduceLabelEdit(cur2, {
            type: "failed",
            error: err?.message ?? "Save failed",
          }),
        };
      });
      addBanner("error", `Could not update label: ${err?.message ?? "error"}`);
    }
  }

  // Delete handler.
  const deleteAction = useAction(deleteFile);
  async function onDelete(row: FileRow) {
    const ok = window.confirm(
      `Delete ${row.original_filename ?? row.path}? This is a soft-delete; the blob is removed but the row stays in the audit trail.`,
    );
    if (!ok) return;
    try {
      await deleteAction({ path: row.path });
      addBanner("info", `Removed ${row.original_filename ?? row.path}`);
      if (selectedPath === row.path) setSelectedPath(null);
      refetchList();
      refetchUsage();
      // The recycle bin's count changes too — refetch so the expander
      // header label updates in lockstep.
      refetchDeleted();
    } catch (err: any) {
      addBanner("error", `Delete failed: ${err?.message ?? "error"}`);
    }
  }

  // ── Recently-deleted expander (#114 §7 + §8) ──────────────────────────
  //
  // The /files surface gains a collapsed-by-default panel listing files
  // soft-deleted in the last 30 days. Each row carries a Restore button
  // that calls the new POST /api/v1/files/restore/:file_id route; the
  // 410 BLOB_REAPED case (sole reference reaped at delete time, bytes
  // gone) surfaces verbatim so Sir sees a clear "this can't be restored"
  // banner rather than a silent no-op.
  const [showDeleted, setShowDeleted] = useState(false);
  const {
    data: deletedData,
    refetch: refetchDeleted,
  } = useQuery(
    listDeletedFiles,
    { limit: 100 },
    { retry: false, enabled: showDeleted },
  );
  const deletedRows: FileRow[] = useMemo(() => {
    const items = (deletedData as any)?.items;
    return Array.isArray(items) ? (items as FileRow[]) : [];
  }, [deletedData]);
  const restoreAction = useAction(restoreFile);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  async function onRestore(row: FileRow) {
    if (restoringId) return;
    setRestoringId(row.id);
    try {
      await restoreAction({ file_id: row.id });
      addBanner(
        "success",
        `Restored ${row.original_filename ?? row.path}`,
      );
      refetchList();
      refetchUsage();
      refetchDeleted();
    } catch (err: any) {
      addBanner(
        "error",
        `Restore failed: ${err?.message ?? "error"}`,
      );
    } finally {
      setRestoringId(null);
    }
  }

  // Upload zone — drag/drop + file-input. Tracks each in-flight upload as
  // an UploadItem; completion refetches the list + usage.
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function startUploads(files: File[]) {
    const usage = (usageData ?? null) as FilesUsage | null;
    const fresh: UploadItem[] = [];
    for (const file of files) {
      const reject = usage ? shouldRejectUpload(file.size, usage) : null;
      if (reject) {
        fresh.push({
          key: `r-${Date.now()}-${Math.random()}`,
          filename: file.name,
          size: file.size,
          loaded: 0,
          status: "rejected",
          error: reject,
        });
        addBanner("error", `Rejected ${file.name}: ${reject}`);
        continue;
      }
      const key = `u-${Date.now()}-${Math.random()}`;
      const queued: UploadItem = {
        key,
        filename: file.name,
        size: file.size,
        loaded: 0,
        status: "queued",
      };
      fresh.push(queued);
      // Mutate to "uploading" + start the XHR on next tick so the row
      // appears in the queue first.
      setTimeout(() => beginUploadXhr(key, file), 0);
    }
    if (fresh.length > 0) setUploads((u) => [...fresh, ...u]);
  }

  function beginUploadXhr(key: string, file: File) {
    setUploads((u) =>
      u.map((it) => (it.key === key ? { ...it, status: "uploading" } : it)),
    );
    uploadFile(file, {
      onProgress: (loaded) => {
        setUploads((u) =>
          u.map((it) => (it.key === key ? { ...it, loaded } : it)),
        );
      },
      onDone: (path) => {
        setUploads((u) =>
          u.map((it) =>
            it.key === key
              ? { ...it, status: "completed", loaded: it.size, resultPath: path }
              : it,
          ),
        );
        addBanner("success", `Uploaded ${file.name}`);
        refetchList();
        refetchUsage();
      },
      onError: (status, message) => {
        setUploads((u) =>
          u.map((it) =>
            it.key === key
              ? { ...it, status: "failed", error: `[${status}] ${message}` }
              : it,
          ),
        );
        addBanner("error", `Upload failed for ${file.name}: ${message}`);
      },
    });
  }

  function onFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) startUploads(files);
    e.target.value = "";
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragHot(true);
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setDragHot(false);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragHot(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) startUploads(files);
  }
  const [dragHot, setDragHot] = useState(false);

  // Banner toasts.
  const [banners, setBanners] = useState<Banner[]>([]);
  function addBanner(tone: Banner["tone"], text: string) {
    const id = Date.now() + Math.random();
    setBanners((b) => [...b, { id, tone, text }]);
    setTimeout(() => {
      setBanners((b) => b.filter((it) => it.id !== id));
    }, 5000);
  }

  // Quota view.
  const quota = usageData ? deriveQuotaView(usageData as FilesUsage) : null;
  const quotaColor =
    quota?.band === "alarm"
      ? "var(--alarm, #b94a48)"
      : quota?.band === "warn"
        ? "var(--amber, #c9952c)"
        : "var(--brass)";

  return (
    <Frame>
      <section className="mx-auto max-w-[1280px] px-8 py-10">
        {/* Heading + upload action */}
        <div className="flex items-baseline justify-between mb-4">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.28em]"
            style={{ color: "var(--brass)" }}
          >
            Files
          </div>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--brass)" }}
          >
            + Upload
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={onFilePick}
            className="hidden"
          />
        </div>

        <p
          className="font-body text-[14px] mb-6 max-w-[58ch]"
          style={{ color: "var(--marginalia)" }}
        >
          Raw documents Alfred can read on your behalf. Drop PDFs, screenshots,
          archives — anything that doesn't belong in the vault as markdown.
        </p>

        {/* Quota strip */}
        {quota && (
          <div className="border border-rule p-3 mb-6">
            <div
              className="font-mono text-[10px] uppercase tracking-[0.22em] flex items-baseline justify-between mb-2"
              style={{ color: "var(--marginalia)" }}
            >
              <span>Quota</span>
              <span style={{ color: quotaColor }}>{quota.summaryLabel}</span>
            </div>
            <div
              className="w-full h-1.5"
              style={{ background: "color-mix(in oklab, var(--brass) 12%, transparent)" }}
            >
              <div
                className="h-full transition-all"
                style={{
                  width: `${Math.max(2, Math.round(quota.fractionOfSoft * 100))}%`,
                  background: quotaColor,
                }}
              />
            </div>
            <div
              className="font-mono text-[10px] mt-2 flex items-baseline justify-between"
              style={{ color: "var(--marginalia)" }}
            >
              <span>
                {quota.usedLabel} of {quota.softCapLabel} soft cap
              </span>
              <span>
                Per-upload limit{" "}
                {formatBytes((usageData as FilesUsage).upload_hard_bytes)}
              </span>
            </div>
          </div>
        )}

        {/* In-flight uploads */}
        {uploads.length > 0 && (
          <div className="border border-rule p-3 mb-6">
            <div
              className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
              style={{ color: "var(--marginalia)" }}
            >
              Uploads
            </div>
            <ul className="space-y-1">
              {uploads.map((u) => (
                <UploadRow key={u.key} item={u} />
              ))}
            </ul>
          </div>
        )}

        {/* Three-pane grid */}
        <div
          className={`grid grid-cols-[220px_1fr_320px] gap-6 border-t border-rule pt-6 min-h-[560px] ${
            dragHot ? "ring-2 ring-[color:var(--brass)] ring-opacity-50" : ""
          }`}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {/* Left — prefix tree */}
          <aside
            className="border-r border-rule pr-4 overflow-auto"
            style={{ maxHeight: "70vh" }}
          >
            <input
              value={pendingQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search files…"
              className="w-full bg-transparent border border-rule px-3 py-2 mb-4 font-body text-[14px] outline-none"
              style={{ borderColor: "var(--rule)" }}
            />
            <button
              type="button"
              onClick={() => setActivePrefix("")}
              className="w-full text-left flex items-baseline gap-2 py-1"
              style={{
                color: activePrefix === "" ? "var(--ink)" : "var(--marginalia)",
              }}
            >
              <span
                className="font-mono text-[10px] w-3"
                style={{ color: "var(--brass)" }}
              >
                ▾
              </span>
              <span className="font-display italic text-[16px]">All files</span>
              <span
                className="font-mono text-[10px] ml-auto"
                style={{ color: "var(--marginalia)" }}
              >
                {tree.count}
              </span>
            </button>
            <ul className="mt-1">
              {tree.children.map((node) => {
                const active = activePrefix === node.prefix;
                return (
                  <li key={node.prefix}>
                    <button
                      type="button"
                      onClick={() => setActivePrefix(node.prefix)}
                      className="w-full text-left flex items-baseline gap-2 py-1 pl-5"
                      style={{
                        color: active ? "var(--ink)" : "var(--marginalia)",
                        borderLeft: active
                          ? "1px solid var(--brass)"
                          : "1px solid transparent",
                        marginLeft: -1,
                      }}
                    >
                      <span className="font-mono text-[11px] truncate">
                        {node.segment.slice(0, 10)}…
                      </span>
                      <span
                        className="font-mono text-[10px] ml-auto"
                        style={{ color: "var(--marginalia)" }}
                      >
                        {node.count}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          {/* Centre — list + drop zone */}
          <div
            className="overflow-auto"
            style={{ maxHeight: "70vh" }}
          >
            <div
              className="border border-dashed p-4 mb-4 text-center"
              style={{
                borderColor: dragHot ? "var(--brass)" : "var(--rule)",
                background: dragHot
                  ? "color-mix(in oklab, var(--brass) 8%, transparent)"
                  : "transparent",
              }}
            >
              <div
                className="font-mono text-[11px] uppercase tracking-[0.22em]"
                style={{ color: "var(--marginalia)" }}
              >
                Drop files here, or use Upload above
              </div>
            </div>

            {listFetching && rows.length === 0 && (
              <p
                className="font-body italic text-[14px]"
                style={{ color: "var(--marginalia)" }}
              >
                Reading the file store…
              </p>
            )}
            {!listFetching && rows.length === 0 && (
              <p
                className="font-body italic text-[14px]"
                style={{ color: "var(--marginalia)" }}
              >
                {appliedQuery || activePrefix
                  ? "Nothing matches that filter."
                  : "No files yet. Drop one in to begin."}
              </p>
            )}

            {rows.length > 0 && (
              <table className="w-full font-body text-[13px]">
                <thead>
                  <tr
                    className="font-mono text-[10px] uppercase tracking-[0.18em]"
                    style={{ color: "var(--marginalia)" }}
                  >
                    <th className="text-left py-2 pr-3">Name</th>
                    <th className="text-right py-2 pr-3">Size</th>
                    <th className="text-left py-2 pr-3">Uploaded</th>
                    <th className="text-left py-2 pr-3">Label</th>
                    <th className="text-left py-2 pr-3">SHA-256</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const sel = row.path === selectedPath;
                    const edit = labelEdits[row.path];
                    const label = labelDraftFor(
                      edit ?? { kind: "idle", value: row.principal_label },
                      row.principal_label,
                    );
                    return (
                      <tr
                        key={row.id}
                        onClick={() => setSelectedPath(row.path)}
                        className="cursor-pointer hover:bg-[color-mix(in_oklab,var(--brass)_4%,transparent)]"
                        style={{
                          borderTop: "1px solid var(--rule)",
                          background: sel
                            ? "color-mix(in oklab, var(--brass) 8%, transparent)"
                            : "transparent",
                        }}
                      >
                        <td className="py-2 pr-3 max-w-[300px]">
                          <span className="truncate inline-block align-bottom max-w-[200px]">
                            {row.original_filename ?? row.path}
                          </span>
                          <AlfredReadBadge row={row} />
                        </td>
                        <td
                          className="py-2 pr-3 text-right font-mono text-[11px]"
                          style={{ color: "var(--marginalia)" }}
                        >
                          {formatBytes(row.size_bytes)}
                        </td>
                        <td
                          className="py-2 pr-3 font-mono text-[11px]"
                          style={{ color: "var(--marginalia)" }}
                        >
                          {formatUploadedAt(row.uploaded_at)}
                        </td>
                        <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                          {edit && (edit.kind === "editing" || edit.kind === "saving") ? (
                            <input
                              autoFocus
                              value={edit.draft}
                              onChange={(e) =>
                                updateLabelDraft(row.path, e.target.value)
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  commitLabelEdit(row.path);
                                }
                                if (e.key === "Escape") {
                                  e.preventDefault();
                                  cancelLabelEdit(row.path);
                                }
                              }}
                              onBlur={() => {
                                // onBlur after Enter would otherwise double-fire commit;
                                // the reducer ignores commit on non-editing states so it's
                                // safe, but we skip if already saving for clarity.
                                if (edit.kind === "editing") commitLabelEdit(row.path);
                              }}
                              disabled={edit.kind === "saving"}
                              className="bg-transparent border border-rule px-2 py-1 font-body text-[12px] w-full outline-none"
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => beginLabelEdit(row)}
                              className="text-left font-body text-[12px] italic"
                              style={{
                                color: label ? "var(--ink)" : "var(--marginalia)",
                              }}
                              title="Click to edit label"
                            >
                              {label || "(add label)"}
                            </button>
                          )}
                        </td>
                        <td
                          className="py-2 pr-3 font-mono text-[11px]"
                          style={{ color: "var(--marginalia)" }}
                        >
                          {shortSha(row.sha256)}
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => onDelete(row)}
                            className="font-mono text-[10px]"
                            style={{ color: "var(--marginalia)" }}
                            title="Delete"
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Right — preview pane */}
          <aside
            className="border-l border-rule pl-4 overflow-auto sticky top-6"
            style={{ maxHeight: "70vh" }}
          >
            {selectedRow ? (
              <PreviewPane row={selectedRow} stat={statData as FileRow | null} />
            ) : (
              <p
                className="font-body italic text-[14px]"
                style={{ color: "var(--marginalia)" }}
              >
                Select a file to preview.
              </p>
            )}
          </aside>
        </div>

        {/* Recently deleted — collapsed-by-default expander. The query
            fires only when expanded so a quiet /files page doesn't pay
            for an extra round-trip. Each row gets a Restore button that
            calls POST /api/v1/files/restore/:file_id. Issue #114 §7. */}
        <div className="border-t border-rule pt-6 mt-8">
          <button
            type="button"
            onClick={() => setShowDeleted((v) => !v)}
            className="flex items-baseline gap-2 font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--marginalia)" }}
            aria-expanded={showDeleted}
            data-testid="files-recently-deleted-toggle"
          >
            <span style={{ color: "var(--brass)" }}>
              {showDeleted ? "▾" : "▸"}
            </span>
            <span>Recently deleted</span>
            {showDeleted && deletedData ? (
              <span style={{ color: "var(--marginalia)" }}>
                ({(deletedData as any).total ?? deletedRows.length} within 30 days)
              </span>
            ) : null}
          </button>
          {showDeleted && (
            <div className="mt-3 border border-rule p-3">
              {deletedRows.length === 0 ? (
                <p
                  className="font-body italic text-[14px]"
                  style={{ color: "var(--marginalia)" }}
                >
                  Nothing recently deleted.
                </p>
              ) : (
                <table className="w-full font-body text-[13px]">
                  <thead>
                    <tr
                      className="font-mono text-[10px] uppercase tracking-[0.18em]"
                      style={{ color: "var(--marginalia)" }}
                    >
                      <th className="text-left py-2 pr-3">Name</th>
                      <th className="text-right py-2 pr-3">Size</th>
                      <th className="text-left py-2 pr-3">Deleted</th>
                      <th className="text-left py-2 pr-3">SHA-256</th>
                      <th className="w-24"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {deletedRows.map((row) => (
                      <tr
                        key={row.id}
                        style={{ borderTop: "1px solid var(--rule)" }}
                        data-testid={`files-deleted-row-${row.id}`}
                      >
                        <td className="py-2 pr-3 truncate max-w-[260px]">
                          {row.original_filename ?? row.path}
                        </td>
                        <td
                          className="py-2 pr-3 text-right font-mono text-[11px]"
                          style={{ color: "var(--marginalia)" }}
                        >
                          {formatBytes(row.size_bytes)}
                        </td>
                        <td
                          className="py-2 pr-3 font-mono text-[11px]"
                          style={{ color: "var(--marginalia)" }}
                        >
                          {row.deleted_at
                            ? formatUploadedAt(row.deleted_at)
                            : ""}
                        </td>
                        <td
                          className="py-2 pr-3 font-mono text-[11px]"
                          style={{ color: "var(--marginalia)" }}
                        >
                          {shortSha(row.sha256)}
                        </td>
                        <td>
                          <button
                            type="button"
                            onClick={() => onRestore(row)}
                            disabled={restoringId === row.id}
                            className="font-mono text-[10px] uppercase tracking-[0.22em]"
                            style={{
                              color:
                                restoringId === row.id
                                  ? "var(--marginalia)"
                                  : "var(--brass)",
                            }}
                            data-testid={`files-restore-${row.id}`}
                            title="Restore this file"
                          >
                            {restoringId === row.id ? "Restoring…" : "↩ Restore"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>

        {/* Banners */}
        {banners.length > 0 && (
          <div className="fixed bottom-6 right-6 space-y-2 z-40">
            {banners.map((b) => (
              <div
                key={b.id}
                className="border px-4 py-2 font-mono text-[11px] max-w-[420px]"
                style={{
                  borderColor:
                    b.tone === "error"
                      ? "var(--alarm, #b94a48)"
                      : b.tone === "success"
                        ? "var(--brass)"
                        : "var(--rule)",
                  background: "var(--paper, #faf6ef)",
                  color: "var(--ink)",
                }}
              >
                {b.text}
              </div>
            ))}
          </div>
        )}
      </section>
    </Frame>
  );
}

// ── upload row ─────────────────────────────────────────────────────────────

// #114 Lane B — the "Alfred read it" badge.
//
// State machine (deriveBadgeState):
//   * settled — brass pill, summary tooltip on hover.
//   * pending — soft pulse + "Reading…" label (≤2 min after upload).
//   * stale   — render nothing (a row Alfred never got around to).
//   * errored — muted "Couldn't read" pill, reason_code on hover.
//
// Kept as a separate component so the row table stays readable.
function AlfredReadBadge({ row }: { row: FileRow }) {
  const state: BadgeState = deriveBadgeState(row);
  if (state === "stale") return null;
  const label = badgeLabel(state);
  const tooltip =
    state === "settled"
      ? row.summary ?? "Alfred read this file."
      : state === "errored"
        ? `Couldn't read: ${row.extraction_error ?? "unknown reason"}`
        : "Alfred is reading this file…";
  const bg =
    state === "settled"
      ? "color-mix(in oklab, var(--brass) 14%, transparent)"
      : state === "errored"
        ? "color-mix(in oklab, var(--marginalia) 18%, transparent)"
        : "color-mix(in oklab, var(--brass) 8%, transparent)";
  const fg =
    state === "settled"
      ? "var(--brass)"
      : state === "errored"
        ? "var(--marginalia)"
        : "var(--brass)";
  const pulse = state === "pending" ? "animate-pulse" : "";
  return (
    <span
      className={`inline-flex items-center px-1.5 py-[1px] ml-2 font-mono text-[9px] uppercase tracking-[0.18em] rounded-sm ${pulse}`}
      style={{ background: bg, color: fg }}
      title={tooltip}
    >
      {label}
    </span>
  );
}

// #114 Lane B — side-panel summary block.
//
// Renders the full extraction summary (settled) or a short reason
// line (errored). Hidden for `pending`/`stale` rows — the badge in
// the row already carries the affordance and the side panel stays
// quiet until Alfred has something to say.
function AlfredReadSummary({ row }: { row: FileRow }) {
  const state: BadgeState = deriveBadgeState(row);
  if (state === "settled" && row.summary) {
    return (
      <div className="border border-rule px-3 py-2 mt-3" style={{ borderColor: "var(--rule)" }}>
        <div
          className="font-mono text-[9px] uppercase tracking-[0.22em] mb-1"
          style={{ color: "var(--brass)" }}
        >
          Alfred read it
        </div>
        <p className="font-body text-[13px] leading-snug" style={{ color: "var(--ink)" }}>
          {row.summary}
        </p>
      </div>
    );
  }
  if (state === "errored") {
    return (
      <div
        className="border border-dashed px-3 py-2 mt-3"
        style={{ borderColor: "var(--rule)" }}
      >
        <div
          className="font-mono text-[9px] uppercase tracking-[0.22em] mb-1"
          style={{ color: "var(--marginalia)" }}
        >
          Couldn't read
        </div>
        <p
          className="font-mono text-[11px]"
          style={{ color: "var(--marginalia)" }}
        >
          {row.extraction_error}
        </p>
      </div>
    );
  }
  return null;
}

function UploadRow({ item }: { item: UploadItem }) {
  const pct = Math.round(uploadPercent(item));
  const isDone = item.status === "completed";
  const isFailed = item.status === "failed" || item.status === "rejected";
  const tone = isFailed
    ? "var(--alarm, #b94a48)"
    : isDone
      ? "var(--brass)"
      : "var(--marginalia)";
  return (
    <li className="font-mono text-[11px]">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate flex-1">
          {item.filename}{" "}
          <span style={{ color: "var(--marginalia)" }}>
            ({formatBytes(item.size)})
          </span>
        </span>
        <span style={{ color: tone }}>
          {isDone ? "✓ done" : isFailed ? `✗ ${item.error ?? "failed"}` : `${pct}%`}
        </span>
      </div>
      {!isFailed && (
        <div
          className="w-full h-[2px] mt-1"
          style={{ background: "var(--rule)" }}
        >
          <div
            className="h-full"
            style={{ width: `${pct}%`, background: tone }}
          />
        </div>
      )}
    </li>
  );
}

// ── preview pane ───────────────────────────────────────────────────────────

function PreviewPane({
  row,
  stat,
}: {
  row: FileRow;
  stat: FileRow | null;
}) {
  const mode: PreviewMode = useMemo(
    () => derivePreviewMode(row.content_type, row.original_filename ?? row.path),
    [row],
  );
  const url = blobUrl(row.path);
  const filename = row.original_filename ?? row.path;
  const stat_size = stat?.size_bytes ?? row.size_bytes;
  const stat_uploaded = stat?.uploaded_at ?? row.uploaded_at;

  return (
    <div className="space-y-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.22em]" style={{ color: "var(--brass)" }}>
        Preview
      </div>
      <div className="font-display text-[18px] italic break-words">{filename}</div>
      <div className="font-mono text-[11px]" style={{ color: "var(--marginalia)" }}>
        {formatBytes(stat_size)} · {formatUploadedAt(stat_uploaded)}
      </div>

      {/* #114 Lane B — "Alfred read it" affordance. The badge appears
          inline in the row; the side panel surfaces the full summary
          (when present) and the reason code (when extraction failed). */}
      <AlfredReadSummary row={stat ?? row} />


      {mode === "image" && (
        <img
          src={url}
          alt={filename}
          className="max-w-full border border-rule"
        />
      )}

      {mode === "pdf" && (
        <iframe
          src={url}
          title={filename}
          className="w-full border border-rule"
          style={{ height: 480 }}
        />
      )}

      {mode === "text" && <TextPreview url={url} />}

      {mode === "audio" && (
        <audio controls className="w-full" src={url} />
      )}

      {mode === "video" && (
        <video controls className="w-full max-h-[420px]" src={url} />
      )}

      {mode === "unknown" && (
        <div
          className="border border-dashed p-4 font-mono text-[11px]"
          style={{ color: "var(--marginalia)" }}
        >
          No inline preview for this file type.
        </div>
      )}

      <a
        href={url}
        download={filename}
        className="font-mono text-[10px] uppercase tracking-[0.22em] block mt-3"
        style={{ color: "var(--brass)" }}
      >
        ↓ Download
      </a>

      {/* Full stat */}
      <details className="border-t border-rule pt-3 mt-3">
        <summary
          className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.22em]"
          style={{ color: "var(--marginalia)" }}
        >
          Details
        </summary>
        <dl className="grid grid-cols-[100px_1fr] gap-y-1 mt-3 font-mono text-[11px]">
          <dt style={{ color: "var(--marginalia)" }}>path</dt>
          <dd className="break-all">{row.path}</dd>
          <dt style={{ color: "var(--marginalia)" }}>sha256</dt>
          <dd className="break-all">{row.sha256}</dd>
          <dt style={{ color: "var(--marginalia)" }}>content-type</dt>
          <dd>{row.content_type ?? "—"}</dd>
          <dt style={{ color: "var(--marginalia)" }}>uploaded by</dt>
          <dd>{row.uploaded_by}</dd>
          {row.last_accessed_at && (
            <>
              <dt style={{ color: "var(--marginalia)" }}>last read</dt>
              <dd>{formatUploadedAt(row.last_accessed_at)}</dd>
            </>
          )}
        </dl>
      </details>
    </div>
  );
}

// ── text preview (small fetch, bail above 256k) ────────────────────────────

function TextPreview({ url }: { url: string }) {
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBody(null);
    setError(null);
    (async () => {
      try {
        const r = await fetch(url, { credentials: "omit" });
        if (!r.ok) {
          if (!cancelled) setError(`HTTP ${r.status}`);
          return;
        }
        const text = await r.text();
        if (cancelled) return;
        // Cap at 256k chars so we don't blow up the page on a 20 MB CSV.
        if (text.length > 256_000) {
          setBody(text.slice(0, 256_000) + "\n\n… (truncated)");
        } else {
          setBody(text);
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? "fetch failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (error) {
    return (
      <div
        className="font-mono text-[11px] border border-rule p-3"
        style={{ color: "var(--alarm, #b94a48)" }}
      >
        Could not load preview: {error}
      </div>
    );
  }
  if (body === null) {
    return (
      <div
        className="font-mono text-[11px] italic"
        style={{ color: "var(--marginalia)" }}
      >
        Loading preview…
      </div>
    );
  }
  return (
    <pre
      className="border border-rule p-3 overflow-auto font-mono text-[11px]"
      style={{ maxHeight: 360, whiteSpace: "pre-wrap" }}
    >
      {body}
    </pre>
  );
}
