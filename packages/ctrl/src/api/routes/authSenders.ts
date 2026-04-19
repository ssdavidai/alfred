// Authorized-senders CRUD for the email channel.
//
// Stored at `${VAULT_PATH}/.auth/authorized_senders.json`. Senders listed
// here are treated as "channel" traffic — inbound emails from them route
// to the openclaw main agent as conversational messages, not the stream
// ingest pipeline.
//
// Seeded at provision time with exactly the tenant owner's Google OAuth
// email (see packages/openclaw/init/entrypoint.sh step 11). No auto-promote,
// no domain wildcards — matches are exact, case-insensitive.

import fs from "node:fs";
import path from "node:path";

import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { VAULT_PATH } from "./vault.js";

const AUTH_DIR = path.join(VAULT_PATH, ".auth");
const SENDERS_FILE = path.join(AUTH_DIR, "authorized_senders.json");

interface SendersFile {
  senders: string[];
  updated_at: string;
}

function readSenders(): SendersFile {
  if (!fs.existsSync(SENDERS_FILE)) {
    return { senders: [], updated_at: new Date().toISOString() };
  }
  try {
    const raw = fs.readFileSync(SENDERS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.senders)) {
      return { senders: [], updated_at: new Date().toISOString() };
    }
    return {
      senders: parsed.senders.map((s: string) => s.toLowerCase()).filter(Boolean),
      updated_at: parsed.updated_at || new Date().toISOString(),
    };
  } catch {
    return { senders: [], updated_at: new Date().toISOString() };
  }
}

function writeSenders(senders: string[]): SendersFile {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const deduped = Array.from(new Set(senders.map((s) => s.toLowerCase()))).sort();
  const payload: SendersFile = {
    senders: deduped,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(SENDERS_FILE, JSON.stringify(payload, null, 2), "utf-8");
  return payload;
}

function isValidEmail(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length >= 3 &&
    v.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
  );
}

/**
 * Exported for the webhook receiver's dispatch lookup.
 * Exact match on lowercased email address, no domain wildcards.
 */
export function isAuthorizedSender(email: string): boolean {
  if (!email) return false;
  const list = readSenders().senders;
  return list.includes(email.toLowerCase());
}

export function registerAuthSendersRoutes(): void {
  // List authorized senders
  addRoute("GET", "/api/v1/auth/senders", async ({ res }) => {
    sendJson(res, 200, readSenders());
  });

  // Add a sender
  addRoute("POST", "/api/v1/auth/senders", async ({ res, body }) => {
    const b = (body ?? {}) as { email?: unknown };
    if (!isValidEmail(b.email)) {
      throw new ValidationError("Valid `email` is required");
    }
    const current = readSenders().senders;
    if (current.includes(b.email.toLowerCase())) {
      sendJson(res, 200, readSenders());
      return;
    }
    const next = [...current, b.email];
    sendJson(res, 201, writeSenders(next));
  });

  // Remove a sender
  addRoute("DELETE", "/api/v1/auth/senders/:email", async ({ res, params }) => {
    const target = decodeURIComponent(params["email"] ?? "").toLowerCase();
    if (!target) {
      throw new ValidationError("email required in path");
    }
    const current = readSenders().senders;
    const next = current.filter((s) => s !== target);
    sendJson(res, 200, writeSenders(next));
  });
}
