import http from "node:http";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { dockerExec, dockerComposeCmd, ALFRED_CMD } from "../helpers.js";
import { enqueueWorkerRun } from "../workerRuns/enqueue.js";
import type { WorkerName } from "../workerRuns/model.js";

/** Legacy inbox bridge retained for non-trigger callers; durable triggers never invoke it. */
async function bridgeInboxToStreams(): Promise<void> {
  const hostname = process.env.AAS_HOST ?? "localhost";
  const portEnv = process.env.AAS_PORT;
  const port = portEnv !== undefined ? Number.parseInt(portEnv, 10) : 3100;
  const effectivePort = Number.isNaN(port) ? 3100 : port;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.AAS_API_KEY) headers.Authorization = `Bearer ${process.env.AAS_API_KEY}`;
  return new Promise((resolve) => {
    const req = http.request({ hostname, port: effectivePort, path: "/api/v1/streams/inbox/scan", method: "POST", headers, timeout: 10000 }, () => resolve());
    req.on("error", () => resolve());
    req.on("timeout", () => { req.destroy(); resolve(); });
    req.end();
  });
}

async function enqueueManualRun(
  worker: WorkerName,
  body: unknown,
  res: Parameters<typeof sendJson>[0],
): Promise<void> {
  const { run, reused } = await enqueueWorkerRun(worker, body);
  const statusUrl = `/api/v1/workers/runs/${run.run_id}`;
  res.setHeader("Location", statusUrl);
  sendJson(res, 202, {
    run_id: run.run_id,
    worker: run.worker,
    state: run.state,
    reused,
    input: run.input,
    status_url: statusUrl,
  });
}

export function registerWorkerRoutes(): void {
  // Overall daemon status
  addRoute("GET", "/api/v1/workers/status", async ({ res }) => {
    const stdout = await dockerExec("alfred", [...ALFRED_CMD, "status"]);
    sendJson(res, 200, { raw: stdout.trim() });
  });

  // Start workers
  addRoute("POST", "/api/v1/workers/up", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    const args = [...ALFRED_CMD, "up", "--foreground"];
    if (b?.only) args.push("--only", b.only as string);
    const stdout = await dockerExec("alfred", args);
    sendJson(res, 200, { message: stdout.trim() || "Workers started" });
  });

  // Stop workers
  addRoute("POST", "/api/v1/workers/down", async ({ res }) => {
    const stdout = await dockerExec("alfred", [...ALFRED_CMD, "down"]);
    sendJson(res, 200, { message: stdout.trim() || "Workers stopped" });
  });

  // Restart alfred container
  addRoute("POST", "/api/v1/workers/restart", async ({ res }) => {
    await dockerComposeCmd(["restart", "alfred"]);
    sendJson(res, 200, { message: "Alfred container restarted" });
  });

  // Ingest (split bulk conversation into inbox)
  addRoute("POST", "/api/v1/workers/ingest", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    const args = [...ALFRED_CMD, "ingest"];
    if (b?.dry_run) args.push("--dry-run");
    const stdout = await dockerExec("alfred", args);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // Durably queue Curator processing; the vault worker owns execution.
  addRoute("POST", "/api/v1/workers/process", async ({ res, body }) => {
    await enqueueManualRun("curator", body, res);
  });

  // --- Janitor ---

  // Janitor status
  addRoute("GET", "/api/v1/workers/janitor/status", async ({ res }) => {
    const stdout = await dockerExec("alfred", [...ALFRED_CMD, "janitor", "status"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // Janitor scan
  addRoute("POST", "/api/v1/workers/janitor/scan", async ({ res }) => {
    const stdout = await dockerExec("alfred", [...ALFRED_CMD, "janitor", "scan"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // Durably queue Janitor repair; the vault worker owns scan and agent work.
  addRoute("POST", "/api/v1/workers/janitor/fix", async ({ res, body }) => {
    await enqueueManualRun("janitor", body, res);
  });

  // Janitor history
  addRoute("GET", "/api/v1/workers/janitor/history", async ({ res, query }) => {
    const limit = query.get("limit") ?? "10";
    const stdout = await dockerExec("alfred", [...ALFRED_CMD, "janitor", "history", "--limit", limit]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // Janitor ignore
  addRoute("POST", "/api/v1/workers/janitor/ignore", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.file !== "string") {
      throw new ValidationError("file is required");
    }
    const args = [...ALFRED_CMD, "janitor", "ignore", b.file as string];
    if (b.reason) args.push("--reason", b.reason as string);
    const stdout = await dockerExec("alfred", args);
    sendJson(res, 200, { message: stdout.trim() || "File ignored" });
  });

  // --- Distiller ---

  // Distiller status
  addRoute("GET", "/api/v1/workers/distiller/status", async ({ res }) => {
    const stdout = await dockerExec("alfred", [...ALFRED_CMD, "distiller", "status"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // Distiller scan
  addRoute("POST", "/api/v1/workers/distiller/scan", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    const args = [...ALFRED_CMD, "distiller", "scan"];
    if (b?.project) args.push("--project", b.project as string);
    const stdout = await dockerExec("alfred", args);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // Durably queue Distiller extraction; the vault worker owns execution.
  addRoute("POST", "/api/v1/workers/distiller/run", async ({ res, body }) => {
    await enqueueManualRun("distiller", body, res);
  });

  // Distiller history
  addRoute("GET", "/api/v1/workers/distiller/history", async ({ res, query }) => {
    const limit = query.get("limit") ?? "10";
    const stdout = await dockerExec("alfred", [...ALFRED_CMD, "distiller", "history", "--limit", limit]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });
}
