import { addRoute } from "../server.js";
import { sendJson } from "../errors.js";
import { dockerExec, ALFRED_CMD } from "../helpers.js";
import { VAULT_PATH, VAULT_ENV, IGNORE_DIRS, walkMd, readRecord } from "./vault.js";

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
      alfred_instructions: string;
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
        name: String(rec.fm.name || rec.stem),
        description: String(rec.fm.description || ""),
        status,
        created: String(rec.fm.created || ""),
        tier: rec.fm.tier ? Number(rec.fm.tier) : null,
        alfred_instructions: String(rec.fm.alfred_instructions || ""),
      });
    }

    results.sort((a, b) => b.created.localeCompare(a.created));
    sendJson(res, 200, { results, count: results.length });
  });

  // Approve — clear requires_approval and set status to queued so TaskRunner picks it up
  addRoute("POST", "/api/v1/approvals/:path/approve", async ({ res, params }) => {
    const recordPath = params.path;
    const args = [
      ...ALFRED_CMD,
      "vault", "edit", recordPath,
      "--set", "requires_approval=false",
      "--set", "status=queued",
    ];
    const stdout = await dockerExec("alfred", args, VAULT_ENV);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout });
    }
  });

  // Reject — cancel the task and clear requires_approval
  addRoute("POST", "/api/v1/approvals/:path/reject", async ({ res, params }) => {
    const recordPath = params.path;
    const args = [
      ...ALFRED_CMD,
      "vault", "edit", recordPath,
      "--set", "requires_approval=false",
      "--set", "status=cancelled",
    ];
    const stdout = await dockerExec("alfred", args, VAULT_ENV);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout });
    }
  });
}
