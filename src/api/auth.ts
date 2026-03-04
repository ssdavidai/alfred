import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { AuthError } from "./errors.js";

let apiKeyBuf: Buffer | null = null;

export function setApiKey(key: string): void {
  apiKeyBuf = Buffer.from(key);
}

export function authenticate(req: IncomingMessage): void {
  if (!apiKeyBuf) return; // no key configured — open access

  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new AuthError("Missing or malformed Authorization header");
  }

  const tokenBuf = Buffer.from(header.slice(7));
  if (
    tokenBuf.length !== apiKeyBuf.length ||
    !crypto.timingSafeEqual(tokenBuf, apiKeyBuf)
  ) {
    throw new AuthError("Invalid API key");
  }
}
