// filesProxy — browser ↔ ctrl-api bridge for /files (#114 PR3).
//
// Wasp queries/actions can't carry multipart streams (they JSON-encode
// args) and can't return raw binary, so the upload + blob endpoints have
// to live as custom Express routes registered on the Wasp server. The
// rest of /files (list/usage/stat/patch/delete) goes through the
// standard `proxyToTenant` queries in operations.ts.
//
// Auth: Wasp session token via Bearer (same pattern as chatProxy /
// terminalProxy). The browser pulls its token from
// `localStorage["wasp:auth"]`; this module validates it via
// `getSessionAndUserFromBearerToken` and only then forwards to ctrl-api
// with the shared AAS_API_KEY secret.
//
// CORS: matches the chat proxy — the SPA host is allowed to call the
// `api.` server with Authorization + Content-Type headers.
//
// Streaming model:
//   POST /api/files/upload          → POST /api/v1/files/upload
//     multipart body relayed byte-for-byte via Node's stream piping;
//     no buffering, no temp file. Content-Length is preserved.
//   GET  /api/files/blob/:path*     → GET /api/v1/files/blob/:path*
//     upstream response is piped back as-is (Content-Type +
//     Content-Disposition preserved) so <img>/<video>/<iframe> in the
//     preview pane work without round-tripping through JSON.

import express from "express";
import cors from "cors";
import type { Application, Request, Response, RequestHandler } from "express";
import type { IncomingMessage } from "http";
import { getSessionAndUserFromBearerToken } from "wasp/auth/session";

const CTRL_API_URL = process.env.CTRL_API_URL ?? "http://ctrl-api:3100";
const CTRL_API_KEY = process.env.AAS_API_KEY ?? "";

// 10 min — generous because a 2 GB upload over a busy compose network
// can run for 5+ minutes; the ctrl-api side enforces the hard cap.
const UPLOAD_TIMEOUT_MS = 10 * 60_000;
const BLOB_TIMEOUT_MS = 60_000;

export const FILES_ROUTE_PREFIX = "/api/files";

/** CORS policy mirroring chatProxy's — needed because these routes live
 *  outside Wasp's router and the SPA host is on a different origin from
 *  the `api.` server. */
function filesCors(): RequestHandler {
  const origin = process.env.WASP_WEB_CLIENT_URL ?? true;
  return cors({
    origin,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "Accept"],
    credentials: false,
  });
}

function bearerOf(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  const q = req.query?.token;
  if (typeof q === "string" && q.length > 0) return q;
  return null;
}

/** Inject `?token=` as an Authorization header so the Wasp auth helper
 *  can read it (it reads from `req.headers.authorization` only). */
function withInjectedBearer(req: Request): IncomingMessage {
  const token = bearerOf(req);
  if (token) {
    (req as unknown as IncomingMessage).headers.authorization =
      `Bearer ${token}`;
  }
  return req as unknown as IncomingMessage;
}

async function getUserIdFromRequest(
  req: IncomingMessage,
): Promise<string | null> {
  try {
    const result = await getSessionAndUserFromBearerToken(req as any);
    return result?.user.id ?? null;
  } catch {
    return null;
  }
}

export function registerFilesProxy(app: Application): void {
  app.use(FILES_ROUTE_PREFIX, filesCors());

  // ── POST /api/files/upload ───────────────────────────────────────
  //
  // Relays a multipart body straight through to ctrl-api. We do NOT
  // attach `express.json()` (the body is binary) and we do NOT buffer
  // — the request is piped into a fetch with `req` as the body so the
  // 2 GB hard cap holds without filling RAM.
  app.post("/api/files/upload", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromRequest(withInjectedBearer(req));
      if (!userId) {
        res.status(401).json({ error: "not_authenticated" });
        return;
      }
      if (!CTRL_API_KEY) {
        res.status(500).json({ error: "AAS_API_KEY not configured" });
        return;
      }

      const upstreamHeaders: Record<string, string> = {
        Authorization: `Bearer ${CTRL_API_KEY}`,
      };
      const ct = req.headers["content-type"];
      if (typeof ct === "string") upstreamHeaders["Content-Type"] = ct;
      const cl = req.headers["content-length"];
      if (typeof cl === "string") upstreamHeaders["Content-Length"] = cl;

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS);
      // `duplex: "half"` is required by undici (Node's built-in fetch)
      // for any request with a streaming body; without it the call
      // throws "RequestInit: duplex option is required when sending a
      // body".
      const upstream = await fetch(`${CTRL_API_URL}/api/v1/files/upload`, {
        method: "POST",
        headers: upstreamHeaders,
        body: req as unknown as ReadableStream,
        // @ts-expect-error — `duplex` is undici-specific, not in stock
        // RequestInit, but Node 22's fetch needs it for streamed bodies.
        duplex: "half",
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));

      const text = await upstream.text();
      res.status(upstream.status);
      res.setHeader(
        "Content-Type",
        upstream.headers.get("content-type") ?? "application/json",
      );
      res.send(text);
    } catch (err: any) {
      if (err?.name === "AbortError") {
        res.status(504).json({ error: "Upload timed out" });
        return;
      }
      res
        .status(502)
        .json({ error: "Upload proxy failed", message: err?.message ?? "" });
    }
  });

  // ── GET /api/files/blob/* ────────────────────────────────────────
  //
  // Streams raw bytes from ctrl-api back to the browser. Content-Type
  // and Content-Disposition are preserved so <img>, <iframe>, <audio>,
  // <video>, and download links all work. Express's `*` wildcard
  // captures the entire `<ULID>/<filename>` tail in `req.params[0]`.
  app.get(/^\/api\/files\/blob\/(.+)$/, async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromRequest(withInjectedBearer(req));
      if (!userId) {
        res.status(401).json({ error: "not_authenticated" });
        return;
      }
      if (!CTRL_API_KEY) {
        res.status(500).json({ error: "AAS_API_KEY not configured" });
        return;
      }
      const tail = req.params[0] ?? "";
      if (!tail) {
        res.status(400).json({ error: "path required" });
        return;
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), BLOB_TIMEOUT_MS);
      const upstream = await fetch(
        `${CTRL_API_URL}/api/v1/files/blob/${tail}`,
        {
          headers: { Authorization: `Bearer ${CTRL_API_KEY}` },
          signal: ctrl.signal,
        },
      );

      if (!upstream.ok || !upstream.body) {
        clearTimeout(timer);
        const text = await upstream.text().catch(() => "");
        res.status(upstream.status).send(text);
        return;
      }

      res.status(upstream.status);
      const passthrough = [
        "content-type",
        "content-length",
        "content-disposition",
        "cache-control",
      ];
      for (const h of passthrough) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      }

      // Pipe the web stream into the express response. Node's fetch
      // returns a Web ReadableStream; convert via `Readable.fromWeb`.
      const { Readable } = await import("node:stream");
      const nodeStream = Readable.fromWeb(
        upstream.body as unknown as import("node:stream/web").ReadableStream,
      );
      nodeStream.on("error", (err) => {
        // Headers already sent; the most we can do is end the response.
        console.error("[filesProxy] blob stream error", err);
        try {
          res.end();
        } catch {
          /* noop */
        }
      });
      nodeStream.on("end", () => clearTimeout(timer));
      nodeStream.pipe(res);
    } catch (err: any) {
      if (err?.name === "AbortError") {
        res.status(504).json({ error: "Blob fetch timed out" });
        return;
      }
      res
        .status(502)
        .json({ error: "Blob proxy failed", message: err?.message ?? "" });
    }
  });
}
