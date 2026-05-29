/**
 * /files — pure logic tests for the principal-facing blob browser
 * (#114 PR3). Mirrors the *CardCore.test.ts pattern used elsewhere on
 * the dashboard so the page can lean on tested fundamentals while the
 * React layer stays UI-only.
 *
 * Run with:
 *   cd packages/web && npx tsx --test src/dashboard/FilesPageCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPrefixTree,
  deriveQuotaView,
  derivePreviewMode,
  filterByPrefix,
  formatBytes,
  formatUploadedAt,
  labelDraftFor,
  makeDebounceController,
  reduceLabelEdit,
  shortSha,
  shouldRejectUpload,
  uploadPercent,
  type FileRow,
  type FilesUsage,
  type LabelEditState,
  type UploadItem,
} from "./FilesPageCore";

// ── shared fixtures ────────────────────────────────────────────────────────

const MB = 1024 * 1024;
const GB = 1024 * MB;

const USAGE_FRESH: FilesUsage = {
  used_bytes: 0,
  count: 0,
  soft_cap_bytes: 10 * GB,
  hard_cap_bytes: 20 * GB,
  upload_soft_bytes: 250 * MB,
  upload_hard_bytes: 2 * GB,
};

const FROZEN_NOW = new Date("2026-05-29T12:00:00Z");

function rowAt(uploaded_at: number, path: string, extras: Partial<FileRow> = {}): FileRow {
  return {
    id: path.split("/")[0] ?? "X",
    path,
    size_bytes: 1024,
    sha256: "deadbeefcafebabe000000000000000000000000000000000000000000000000",
    content_type: null,
    original_filename: path.split("/").pop() ?? null,
    principal_label: null,
    uploaded_by: "principal",
    uploaded_at,
    last_accessed_at: null,
    deleted_at: null,
    ...extras,
  };
}

// ── 1 · quota math ─────────────────────────────────────────────────────────

test("formatBytes: B / KB / MB / GB rendering", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(MB), "1 MB");
  assert.equal(formatBytes(2 * GB), "2 GB");
  assert.equal(formatBytes(-1), "0 B"); // defensive
});

test("deriveQuotaView: empty store is calm at 0%", () => {
  const v = deriveQuotaView(USAGE_FRESH);
  assert.equal(v.band, "calm");
  assert.equal(v.fractionOfSoft, 0);
  assert.equal(v.percentOfSoft, 0);
  assert.equal(v.usedLabel, "0 B");
  assert.equal(v.softCapLabel, "10 GB");
  assert.equal(v.summaryLabel, "0% of 10 GB used");
});

test("deriveQuotaView: 50% of soft is calm", () => {
  const v = deriveQuotaView({ ...USAGE_FRESH, used_bytes: 5 * GB });
  assert.equal(v.band, "calm");
  assert.equal(v.fractionOfSoft, 0.5);
  assert.equal(Math.round(v.percentOfSoft), 50);
});

test("deriveQuotaView: 80% of soft trips the amber warn band", () => {
  const v = deriveQuotaView({ ...USAGE_FRESH, used_bytes: 8 * GB });
  assert.equal(v.band, "warn");
  assert.equal(v.fractionOfSoft, 0.8);
});

test("deriveQuotaView: ≥ hard cap is the alarm band, bar pinned at 100%", () => {
  const v = deriveQuotaView({ ...USAGE_FRESH, used_bytes: 20 * GB });
  assert.equal(v.band, "alarm");
  assert.equal(v.fractionOfSoft, 1); // clamped
  assert.equal(Math.round(v.percentOfSoft), 200);
});

test("deriveQuotaView: just over hard cap stays alarm", () => {
  const v = deriveQuotaView({ ...USAGE_FRESH, used_bytes: 22 * GB });
  assert.equal(v.band, "alarm");
});

// ── 2 · preview mode ───────────────────────────────────────────────────────

test("derivePreviewMode: content-type wins for image/*", () => {
  assert.equal(derivePreviewMode("image/png", "blob"), "image");
  assert.equal(derivePreviewMode("image/jpeg", "anything.zzz"), "image");
});

test("derivePreviewMode: application/pdf → pdf", () => {
  assert.equal(derivePreviewMode("application/pdf", null), "pdf");
});

test("derivePreviewMode: text/* and structured-text fall into text", () => {
  assert.equal(derivePreviewMode("text/plain", "x.txt"), "text");
  assert.equal(derivePreviewMode("application/json", "x.json"), "text");
  assert.equal(derivePreviewMode("text/markdown", "x.md"), "text");
});

test("derivePreviewMode: extension fallback when content-type is missing", () => {
  assert.equal(derivePreviewMode(null, "report.PDF"), "pdf");
  assert.equal(derivePreviewMode("", "notes.md"), "text");
  assert.equal(derivePreviewMode(null, "screenshot.png"), "image");
  assert.equal(derivePreviewMode(null, "track.mp3"), "audio");
  assert.equal(derivePreviewMode(null, "clip.webm"), "video");
});

test("derivePreviewMode: truly unknown blob is unknown (caller renders stat + download)", () => {
  assert.equal(derivePreviewMode(null, "archive.bin"), "unknown");
  assert.equal(derivePreviewMode("application/octet-stream", "no-ext"), "unknown");
});

// ── 3 · search debounce ────────────────────────────────────────────────────
//
// We avoid node:timers/promises here so the test stays deterministic — a
// hand-rolled fake scheduler advances "time" synchronously and tracks
// whether the pending handle was correctly cleared on the next push.

function makeFakeScheduler() {
  const pending: { ms: number; cb: () => void; handle: number }[] = [];
  let nextHandle = 1;
  return {
    setTimeout(cb: () => void, ms: number) {
      const handle = nextHandle++;
      pending.push({ ms, cb, handle });
      return handle;
    },
    clearTimeout(handle: unknown) {
      const idx = pending.findIndex((p) => p.handle === handle);
      if (idx >= 0) pending.splice(idx, 1);
    },
    /** Fire every pending callback in FIFO order. */
    flush() {
      while (pending.length > 0) {
        const next = pending.shift()!;
        next.cb();
      }
    },
    countPending() {
      return pending.length;
    },
  };
}

test("makeDebounceController: emits the latest value after the cooldown", () => {
  const fake = makeFakeScheduler();
  let last = "";
  const ctl = makeDebounceController(
    300,
    (v) => {
      last = v;
    },
    fake,
  );
  ctl.push("a");
  assert.equal(fake.countPending(), 1);
  assert.equal(ctl.pending(), true);
  assert.equal(last, ""); // not yet emitted

  fake.flush();
  assert.equal(last, "a");
  assert.equal(ctl.pending(), false);
});

test("makeDebounceController: a new push resets the timer (keystroke storm)", () => {
  const fake = makeFakeScheduler();
  let emissions = 0;
  let last = "";
  const ctl = makeDebounceController(
    300,
    (v) => {
      emissions += 1;
      last = v;
    },
    fake,
  );
  ctl.push("a");
  ctl.push("ab");
  ctl.push("abc");
  // Only ONE pending timer should exist — the prior two were cleared.
  assert.equal(fake.countPending(), 1);
  fake.flush();
  assert.equal(emissions, 1);
  assert.equal(last, "abc");
});

test("makeDebounceController: cancel() drops the pending emission", () => {
  const fake = makeFakeScheduler();
  let emissions = 0;
  const ctl = makeDebounceController(
    300,
    () => {
      emissions += 1;
    },
    fake,
  );
  ctl.push("x");
  ctl.cancel();
  assert.equal(ctl.pending(), false);
  fake.flush();
  assert.equal(emissions, 0);
});

// ── 4 · label-edit state machine ───────────────────────────────────────────

test("reduceLabelEdit: idle → editing → saving → settled", () => {
  let s: LabelEditState = { kind: "idle", value: null };
  s = reduceLabelEdit(s, { type: "begin" });
  assert.equal(s.kind, "editing");
  s = reduceLabelEdit(s, { type: "change", draft: "Tax 2024" });
  assert.equal(s.kind, "editing");
  if (s.kind === "editing") assert.equal(s.draft, "Tax 2024");
  s = reduceLabelEdit(s, { type: "commit" });
  assert.equal(s.kind, "saving");
  s = reduceLabelEdit(s, { type: "saved", value: "Tax 2024" });
  assert.equal(s.kind, "settled");
  if (s.kind === "settled") assert.equal(s.value, "Tax 2024");
});

test("reduceLabelEdit: saving → failed reverts to the original value", () => {
  let s: LabelEditState = { kind: "idle", value: "old" };
  s = reduceLabelEdit(s, { type: "begin" });
  s = reduceLabelEdit(s, { type: "change", draft: "new" });
  s = reduceLabelEdit(s, { type: "commit" });
  s = reduceLabelEdit(s, { type: "failed", error: "503" });
  assert.equal(s.kind, "reverted");
  if (s.kind === "reverted") {
    assert.equal(s.value, "old");
    assert.equal(s.error, "503");
  }
});

test("reduceLabelEdit: editing → cancel restores the original value", () => {
  let s: LabelEditState = { kind: "idle", value: "keep me" };
  s = reduceLabelEdit(s, { type: "begin" });
  s = reduceLabelEdit(s, { type: "change", draft: "DROP TABLE" });
  s = reduceLabelEdit(s, { type: "cancel" });
  assert.equal(s.kind, "idle");
  if (s.kind === "idle") assert.equal(s.value, "keep me");
});

test("labelDraftFor: optimistic display during editing/saving", () => {
  const idle: LabelEditState = { kind: "idle", value: "row" };
  assert.equal(labelDraftFor(idle, "fallback"), "row");
  const editing: LabelEditState = { kind: "editing", draft: "typed", original: "row" };
  assert.equal(labelDraftFor(editing, "fallback"), "typed");
  const saving: LabelEditState = { kind: "saving", draft: "typed", original: "row" };
  assert.equal(labelDraftFor(saving, "fallback"), "typed");
  const settled: LabelEditState = { kind: "settled", value: "confirmed" };
  assert.equal(labelDraftFor(settled, "fallback"), "confirmed");
  const reverted: LabelEditState = { kind: "reverted", value: "row", error: "x" };
  assert.equal(labelDraftFor(reverted, "fallback"), "row");
});

// ── 5 · upload state ───────────────────────────────────────────────────────

test("uploadPercent: clamps and reports 100 on completed", () => {
  const queued: UploadItem = {
    key: "k",
    filename: "a.pdf",
    size: 100,
    loaded: 0,
    status: "queued",
  };
  assert.equal(uploadPercent(queued), 0);
  const half: UploadItem = { ...queued, status: "uploading", loaded: 50 };
  assert.equal(uploadPercent(half), 50);
  const done: UploadItem = { ...queued, status: "completed", loaded: 100 };
  assert.equal(uploadPercent(done), 100);
  // Server's reported `loaded` overshooting is clamped — XHR
  // progressEvent.total can occasionally exceed `size` by a header byte.
  const over: UploadItem = { ...queued, status: "uploading", loaded: 200 };
  assert.equal(uploadPercent(over), 100);
});

test("shouldRejectUpload: oversize trips per-upload hard cap", () => {
  const reason = shouldRejectUpload(3 * GB, USAGE_FRESH);
  assert.match(reason ?? "", /per-upload hard cap/);
});

test("shouldRejectUpload: tail would push past tenant hard cap", () => {
  const near = { ...USAGE_FRESH, used_bytes: 19.9 * GB };
  const reason = shouldRejectUpload(0.5 * GB, near);
  assert.match(reason ?? "", /hard cap/);
});

test("shouldRejectUpload: well-within is accepted", () => {
  assert.equal(shouldRejectUpload(10 * MB, USAGE_FRESH), null);
});

// ── 6 · prefix tree + display helpers ──────────────────────────────────────

test("buildPrefixTree: groups by leading ULID segment, newest-first", () => {
  const rows: FileRow[] = [
    rowAt(1000, "01ABC/old.pdf"),
    rowAt(3000, "01XYZ/newest.png"),
    rowAt(2000, "01ABC/middle.pdf"),
  ];
  const tree = buildPrefixTree(rows);
  assert.equal(tree.count, 3);
  assert.equal(tree.children.length, 2);
  // Newest ULID surfaced first because we sort by uploaded_at desc
  // and pull the leading segment as we go.
  assert.equal(tree.children[0].segment, "01XYZ");
  assert.equal(tree.children[0].count, 1);
  assert.equal(tree.children[1].segment, "01ABC");
  assert.equal(tree.children[1].count, 2);
});

test("filterByPrefix: a prefix narrows the list, empty returns input", () => {
  const rows: FileRow[] = [
    rowAt(1, "01ABC/a.pdf"),
    rowAt(2, "01XYZ/b.png"),
    rowAt(3, "01ABC/c.txt"),
  ];
  assert.equal(filterByPrefix(rows, "").length, 3);
  assert.equal(filterByPrefix(rows, "01ABC/").length, 2);
  assert.equal(filterByPrefix(rows, "01XYZ/").length, 1);
  assert.equal(filterByPrefix(rows, "01NOPE/").length, 0);
});

test("shortSha: 12-char column display, safe on short or null-ish inputs", () => {
  assert.equal(shortSha("deadbeefcafebabe1234"), "deadbeefcafe");
  assert.equal(shortSha("abc"), "abc");
  assert.equal(shortSha(""), "");
});

test("formatUploadedAt: relative buckets up to a week, then ISO date", () => {
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  const now = FROZEN_NOW;
  assert.equal(formatUploadedAt(now.getTime() - 30_000, now), "just now");
  assert.equal(formatUploadedAt(now.getTime() - 5 * min, now), "5 min ago");
  assert.equal(formatUploadedAt(now.getTime() - 2 * hour, now), "2 h ago");
  assert.equal(formatUploadedAt(now.getTime() - 3 * day, now), "3 d ago");
  // Beyond a week → ISO date (YYYY-MM-DD)
  assert.match(
    formatUploadedAt(now.getTime() - 30 * day, now),
    /^\d{4}-\d{2}-\d{2}$/,
  );
  assert.equal(formatUploadedAt(now.getTime() + 60_000, now), "in the future");
});
