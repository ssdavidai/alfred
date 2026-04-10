import fs from "node:fs";
import path from "node:path";

import { addRoute } from "../server.js";
import { sendJson, NotFoundError } from "../errors.js";
import { VAULT_PATH, IGNORE_DIRS, walkMd, readRecord } from "./vault.js";

/**
 * Patch frontmatter fields in a vault record by reading the file,
 * updating YAML keys, and writing back. Avoids the `alfred vault edit`
 * CLI which validates field names against a schema and rejects
 * non-standard fields like `approved`.
 */
function patchFrontmatter(
  recordPath: string,
  updates: Record<string, string | boolean>,
): void {
  const absPath = path.resolve(VAULT_PATH, recordPath);
  if (!fs.existsSync(absPath)) {
    throw new NotFoundError(`Record not found: ${recordPath}`);
  }
  let content = fs.readFileSync(absPath, "utf-8");
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return;

  let fm = fmMatch[1];
  for (const [key, value] of Object.entries(updates)) {
    const strVal = String(value);
    const lineRe = new RegExp(`^${key}:\\s*.*$`, "m");
    if (lineRe.test(fm)) {
      fm = fm.replace(lineRe, `${key}: ${strVal}`);
    } else {
      fm = fm.trimEnd() + `\n${key}: ${strVal}`;
    }
  }

  content = content.replace(/^---\n[\s\S]*?\n---/, `---\n${fm}\n---`);
  fs.writeFileSync(absPath, content, "utf-8");
}

export function registerApprovalRoutes(): void {
  // List pending approvals — tasks where requires_approval=true and status is queued or todo
  addRoute("GET", "/api/v1/approvals/pending", async ({ res }) => {
    const files = walkMd(VAULT_PATH, VAULT_PATH, IGNORE_DIRS);
    const results: Array<{
      path: string;
      name: string;
      description: string;
      status: string;
      created: string;
      tier: number | null;
      source_instinct: string;
      confidence_score: string;
    }> = [];

    for (const relPath of files) {
      const rec = readRecord(relPath);
      if (!rec) continue;
      if (rec.fm.type !== "task") continue;

      const requiresApproval = rec.fm.requires_approval === "true" || rec.fm.requires_approval === true;
      const status = String(rec.fm.status || "");
      if (!requiresApproval || (status !== "queued" && status !== "todo")) continue;

      results.push({
        path: relPath.replace(/\\/g, "/"),
        name: String(rec.fm.name || rec.fm.title || rec.stem),
        description: String(rec.fm.description || ""),
        status,
        created: String(rec.fm.created || ""),
        tier: rec.fm.tier ? Number(rec.fm.tier) : null,
        source_instinct: String(rec.fm.source_instinct || ""),
        confidence_score: String(rec.fm.confidence_score || ""),
      });
    }

    results.sort((a, b) => b.created.localeCompare(a.created));
    sendJson(res, 200, { results, count: results.length });
  });

  // Approve — set approved=true so TaskRunner's check_task_prerequisites passes.
  // Uses direct file patching instead of alfred vault edit CLI because the CLI
  // validates field names and rejects non-standard fields like `approved`.
  addRoute("POST", "/api/v1/approvals/:path/approve", async ({ res, params }) => {
    const recordPath = params.path;
    patchFrontmatter(recordPath, {
      approved: true,
      requires_approval: false,
      status: "queued",
    });
    const rec = readRecord(recordPath);
    sendJson(res, 200, { approved: true, path: recordPath, record: rec?.fm });
  });

  // Reject — cancel the task and clear requires_approval
  addRoute("POST", "/api/v1/approvals/:path/reject", async ({ res, params }) => {
    const recordPath = params.path;
    patchFrontmatter(recordPath, {
      requires_approval: false,
      status: "cancelled",
    });
    const rec = readRecord(recordPath);
    sendJson(res, 200, { rejected: true, path: recordPath, record: rec?.fm });
  });
}
