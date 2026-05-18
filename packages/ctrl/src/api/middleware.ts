import type { IncomingMessage, ServerResponse } from "node:http";

export function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

/**
 * Drain the request stream and return the exact bytes received.
 * Used for HMAC-verified webhook endpoints where the signature is over
 * the raw body as-transmitted (re-serializing would change whitespace).
 */
export function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers["content-type"] ?? "";
    if (req.method === "GET" || req.method === "DELETE" || req.method === "OPTIONS") {
      return resolve(undefined);
    }
    if (contentType && !contentType.includes("application/json")) {
      return resolve(undefined);
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export function logRequest(method: string, url: string, status: number, ms: number): void {
  console.log(`${method} ${url} ${status} ${ms}ms`);
}
