// Lane CTRL — Paperclip admin routes (/api/v1/paperclip/admin/*).
//
// Contract: docs/PAPERCLIP-BOOTSTRAP-CONTRACT.md clause C1.
//
// These are the *provider* routes the mcp-server paperclip tools (C2) and the
// bootstrap skill (C4) call to stand up a Paperclip company on behalf of the
// principal. ctrl-api performs every privileged Paperclip call SERVER-SIDE
// using the seed-credential Better-Auth cookie session — the proven path in
// packages/hermes/init/bootstrap-paperclip.sh (steps 6–10). We never expose
// the seed identity (password / agent token / board token) to the caller; the
// only secret that crosses the boundary is a freshly-minted user password on
// the register-user route (#3), which the caller asked us to mint.
//
// Auth
// ----
//   * Operator-authed: these routes live under /api/v1/ and are NOT in the
//     server.ts isPublic allowlist, so the server-level authenticate() gate
//     runs before the handler — same as every other admin surface. No
//     per-handler auth needed.
//   * Server→Paperclip auth is a Better-Auth cookie session established from
//     /alfred-data/paperclip-seed-credentials.json (written by
//     bootstrap-paperclip.sh step 11a). We POST /api/auth/sign-in/email with
//     mandatory Host + Origin headers (Better-Auth drops Set-Cookie without
//     them — see bootstrap-paperclip.sh:387) and reuse the cookie jar for all
//     subsequent calls.
//   * If the seed-credentials file is absent → 503 {error:"paperclip_not_seeded"}.
//
// Idempotency
// -----------
// Every write route is safe to re-run: create-or-find-by-name for companies
// and agents (matching bootstrap-paperclip.sh:529–552 / 590–607), and
// register-user treats EMAIL_TAKEN as created:false.

import crypto from "node:crypto";
import fs from "node:fs";
import type { ServerResponse } from "node:http";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, ApiError } from "../errors.js";
import type { ApiRequest } from "../server.js";

// ── config ──────────────────────────────────────────────────────────────────

const SEED_CREDENTIALS_PATH = "/alfred-data/paperclip-seed-credentials.json";

function seedCredentialsPath(): string {
  return (
    process.env.PAPERCLIP_SEED_CREDENTIALS_FILE ?? SEED_CREDENTIALS_PATH
  );
}

/** Compose-internal Paperclip URL we actually connect to (default
 *  http://paperclip:3100). The public Host/Origin headers are spoofed so
 *  Better-Auth's trustedOrigins allowlist accepts us. */
function paperclipInternalUrl(): string {
  return (process.env.PAPERCLIP_INTERNAL_URL ?? "http://paperclip:3100").replace(
    /\/+$/,
    "",
  );
}

/** Public Paperclip origin used for the Host + Origin headers AND the
 *  loginUrl on register-user. Mirrors bootstrap-paperclip.sh:139 —
 *  PAPERCLIP_BASE_URL wins, else derived from $DOMAIN. */
function paperclipPublicUrl(): string {
  if (process.env.PAPERCLIP_BASE_URL) {
    return process.env.PAPERCLIP_BASE_URL.replace(/\/+$/, "");
  }
  const domain =
    process.env.DOMAIN ?? process.env.TENANT_DOMAIN ?? "alfred.black";
  return `https://paperclip.${domain}`;
}

function paperclipPublicHost(): string {
  try {
    return new URL(paperclipPublicUrl()).host;
  } catch {
    const domain =
      process.env.DOMAIN ?? process.env.TENANT_DOMAIN ?? "alfred.black";
    return `paperclip.${domain}`;
  }
}

// ── HTTP transport (mockable) ────────────────────────────────────────────────
//
// One injectable transport so tests can drive the request-shaping +
// idempotency logic without a live Paperclip. The cookie jar is a plain
// string[] of `name=value` pairs accumulated from Set-Cookie headers.

export interface PaperclipResponse {
  status: number;
  /** Parsed JSON body when the response was JSON; otherwise the raw text. */
  body: unknown;
  /** Set-Cookie values returned by this response (name=value pairs). */
  setCookies: string[];
}

export type PaperclipTransport = (
  method: string,
  path: string,
  body: unknown | null,
  cookies: string[],
) => Promise<PaperclipResponse>;

/** Live transport — fetch against PAPERCLIP_INTERNAL_URL with the mandatory
 *  Host + Origin headers and a manual cookie jar. */
const liveTransport: PaperclipTransport = async (method, path, body, cookies) => {
  const url = paperclipInternalUrl() + path;
  const headers: Record<string, string> = {
    Host: paperclipPublicHost(),
    Origin: paperclipPublicUrl(),
    Accept: "application/json",
    "User-Agent": "alfred-paperclip-admin/1.0",
  };
  if (cookies.length > 0) headers.Cookie = cookies.join("; ");
  let payload: string | undefined;
  if (body !== null && body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  const resp = await fetch(url, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(30_000),
  });
  // Node's undici exposes the raw Set-Cookie list via getSetCookie().
  const setCookies: string[] = [];
  const getSetCookie = (resp.headers as unknown as {
    getSetCookie?: () => string[];
  }).getSetCookie;
  if (typeof getSetCookie === "function") {
    for (const c of getSetCookie.call(resp.headers)) {
      const pair = c.split(";")[0]?.trim();
      if (pair) setCookies.push(pair);
    }
  } else {
    const single = resp.headers.get("set-cookie");
    if (single) {
      const pair = single.split(";")[0]?.trim();
      if (pair) setCookies.push(pair);
    }
  }
  const text = await resp.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: resp.status, body: parsed, setCookies };
};

let transport: PaperclipTransport = liveTransport;

/** Test hook — swap the HTTP transport. Returns a restore fn. NOT part of
 *  the HTTP surface. */
export function _setPaperclipTransportForTests(
  t: PaperclipTransport | null,
): void {
  transport = t ?? liveTransport;
}

// ── cookie-session client ────────────────────────────────────────────────────

/** A live Paperclip session: a cookie jar that accumulates Set-Cookie pairs
 *  across requests and a helper to issue authenticated calls. */
class PaperclipSession {
  private cookies: string[] = [];

  private mergeCookies(setCookies: string[]): void {
    for (const c of setCookies) {
      const eq = c.indexOf("=");
      if (eq <= 0) continue;
      const name = c.slice(0, eq);
      const next = this.cookies.filter((x) => x.split("=")[0] !== name);
      next.push(c);
      this.cookies = next;
    }
  }

  async call(
    method: string,
    path: string,
    body: unknown | null = null,
  ): Promise<PaperclipResponse> {
    const resp = await transport(method, path, body, this.cookies);
    this.mergeCookies(resp.setCookies);
    return resp;
  }
}

/** Sentinel thrown when the tenant has not been seeded. Handled by
 *  withPaperclipErrors → 503 {error:"paperclip_not_seeded"} (the exact
 *  C1-frozen shape — NOT the wrapped ApiError envelope). */
class PaperclipNotSeededError extends Error {}

interface SeedCredentials {
  email: string;
  password: string;
}

function readSeedCredentials(): SeedCredentials {
  let raw: string;
  try {
    raw = fs.readFileSync(seedCredentialsPath(), "utf-8");
  } catch {
    throw new PaperclipNotSeededError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PaperclipNotSeededError();
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new PaperclipNotSeededError();
  }
  const j = parsed as Record<string, unknown>;
  if (
    typeof j.email !== "string" ||
    !j.email ||
    typeof j.password !== "string" ||
    !j.password
  ) {
    throw new PaperclipNotSeededError();
  }
  return { email: j.email, password: j.password };
}

/** Establish a Better-Auth cookie session as the seed identity. Throws
 *  PaperclipNotSeededError (503) when creds are absent, or a 502 when
 *  Paperclip rejects the sign-in. */
async function establishSession(): Promise<PaperclipSession> {
  const creds = readSeedCredentials();
  const session = new PaperclipSession();
  const resp = await session.call("POST", "/api/auth/sign-in/email", {
    email: creds.email,
    password: creds.password,
  });
  if (resp.status >= 400) {
    throw new ApiError(502, "PAPERCLIP_SIGNIN_FAILED", "paperclip sign-in failed", {
      detail: bodyDetail(resp.body),
    });
  }
  return session;
}

// ── small helpers ─────────────────────────────────────────────────────────────

/** Paperclip list endpoints return either a bare array or {data:[...]}. */
function asList(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) {
    return body.filter(
      (x): x is Record<string, unknown> => typeof x === "object" && x !== null,
    );
  }
  if (typeof body === "object" && body !== null) {
    const data = (body as Record<string, unknown>).data;
    if (Array.isArray(data)) {
      return data.filter(
        (x): x is Record<string, unknown> =>
          typeof x === "object" && x !== null,
      );
    }
  }
  return [];
}

function findByName(
  items: Record<string, unknown>[],
  name: string,
): Record<string, unknown> | null {
  for (const it of items) {
    if (it.name === name) return it;
  }
  return null;
}

/** Extract a short, safe detail string from a Paperclip error body for the
 *  502 envelope. Never leaks more than the first 512 chars. */
function bodyDetail(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 512);
  try {
    return JSON.stringify(body).slice(0, 512);
  } catch {
    return "";
  }
}

/** True when a 4xx body looks like an "already exists" / idempotent case. */
function isExistsError(status: number, body: unknown): boolean {
  if (status !== 400 && status !== 409 && status !== 422) return false;
  let code = "";
  if (typeof body === "object" && body !== null) {
    const c = (body as Record<string, unknown>).code;
    if (typeof c === "string") code = c.toUpperCase();
  }
  return (
    status === 409 ||
    code.includes("EXIST") ||
    code.includes("TAKEN") ||
    code.includes("DUPLICATE") ||
    code.includes("EMAIL")
  );
}

/** OWASP-class password generator (24 chars, URL-safe alphabet) for users
 *  registered without an explicit password. Never logged. */
function generateStrongPassword(): string {
  return crypto
    .randomBytes(48)
    .toString("base64")
    .replace(/[/+=]/g, "")
    .slice(0, 24);
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new ValidationError(`${field} (non-empty string) is required`);
  }
  return v;
}

// ── routes ────────────────────────────────────────────────────────────────────

/** Wrap a handler so a PaperclipNotSeededError surfaces the exact C1 503
 *  shape `{error:"paperclip_not_seeded"}` (a plain string `error`, not the
 *  framework's `{error:{code,message}}` envelope — the MCP consumer + skill
 *  match on this literal). Everything else flows through handleError. */
function withPaperclipErrors(
  fn: (ctx: ApiRequest) => Promise<void>,
): (ctx: ApiRequest) => Promise<void> {
  return async (ctx) => {
    try {
      await fn(ctx);
    } catch (err) {
      if (err instanceof PaperclipNotSeededError) {
        sendJson(ctx.res as ServerResponse, 503, {
          error: "paperclip_not_seeded",
        });
        return;
      }
      throw err;
    }
  };
}

export function registerPaperclipAdminRoutes(): void {
  // 1. POST /companies — create-or-find by name.
  addRoute("POST", "/api/v1/paperclip/admin/companies", withPaperclipErrors(async ({ res, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const name = requireString(b.name, "name");
    const description = typeof b.description === "string" ? b.description : "";
    const session = await establishSession();

    const created = await session.call("POST", "/api/companies/", {
      name,
      description,
    });
    if (created.status >= 200 && created.status < 300) {
      const id = (created.body as Record<string, unknown> | null)?.id;
      if (typeof id !== "string" || !id) {
        throw new ApiError(502, "PAPERCLIP_BAD_RESPONSE", "paperclip company create returned no id", {
          detail: bodyDetail(created.body),
        });
      }
      sendJson(res, 200, { companyId: id, created: true });
      return;
    }
    if (isExistsError(created.status, created.body)) {
      const list = await session.call("GET", "/api/companies/", null);
      if (list.status >= 400) {
        throw new ApiError(502, "PAPERCLIP_LOOKUP_FAILED", "paperclip company lookup failed", {
          detail: bodyDetail(list.body),
        });
      }
      const existing = findByName(asList(list.body), name);
      const id = existing?.id;
      if (typeof id === "string" && id) {
        sendJson(res, 200, { companyId: id, created: false });
        return;
      }
    }
    throw new ApiError(502, "PAPERCLIP_CREATE_FAILED", "paperclip company create failed", {
      detail: bodyDetail(created.body),
    });
  }));

  // 2. POST /companies/:companyId/agents — force hermes_local + mint key.
  addRoute(
    "POST",
    "/api/v1/paperclip/admin/companies/:companyId/agents",
    withPaperclipErrors(async ({ res, params, body }) => {
      const companyId = requireString(params.companyId, "companyId");
      const b = (body ?? {}) as Record<string, unknown>;
      const name = requireString(b.name, "name");
      const role = requireString(b.role, "role");
      const session = await establishSession();

      const agentBody: Record<string, unknown> = {
        name,
        role,
        // C1: ctrl-api FORCES the adapter type — the runtime is the tenant's
        // own Hermes (see bootstrap-paperclip.sh:585).
        adapterType: "hermes_local",
      };
      if (typeof b.title === "string") agentBody.title = b.title;
      if (typeof b.capabilities === "string") {
        agentBody.capabilities = b.capabilities;
      }

      const created = await session.call(
        "POST",
        `/api/companies/${encodeURIComponent(companyId)}/agents`,
        agentBody,
      );

      let agentId: string | null = null;
      let wasCreated = false;
      if (created.status >= 200 && created.status < 300) {
        const id = (created.body as Record<string, unknown> | null)?.id;
        if (typeof id === "string" && id) {
          agentId = id;
          wasCreated = true;
        } else {
          throw new ApiError(502, "PAPERCLIP_BAD_RESPONSE", "paperclip agent create returned no id", {
            detail: bodyDetail(created.body),
          });
        }
      } else if (isExistsError(created.status, created.body)) {
        const list = await session.call(
          "GET",
          `/api/companies/${encodeURIComponent(companyId)}/agents`,
          null,
        );
        if (list.status >= 400) {
          throw new ApiError(502, "PAPERCLIP_LOOKUP_FAILED", "paperclip agent lookup failed", {
            detail: bodyDetail(list.body),
          });
        }
        const existing = findByName(asList(list.body), name);
        const id = existing?.id;
        if (typeof id === "string" && id) agentId = id;
      }

      if (!agentId) {
        throw new ApiError(502, "PAPERCLIP_CREATE_FAILED", "paperclip agent create failed", {
          detail: bodyDetail(created.body),
        });
      }

      // Mint the runtime key. Only meaningful on a fresh create — Paperclip
      // never returns an existing key's value, so for an already-existing
      // agent we return agentToken:null (idempotent: created:false).
      let agentToken: string | null = null;
      if (wasCreated) {
        const key = await session.call(
          "POST",
          `/api/agents/${encodeURIComponent(agentId)}/keys`,
          { name: `${name}-runtime` },
        );
        if (key.status >= 200 && key.status < 300) {
          const kb = key.body as Record<string, unknown> | null;
          const tok = kb?.token ?? kb?.apiKey ?? kb?.key;
          if (typeof tok === "string" && tok) agentToken = tok;
        }
        // A key-mint failure is non-fatal: the agent exists. The caller can
        // re-run or mint a key via Paperclip's UI. agentToken stays null.
      }

      sendJson(res, 200, {
        agentId,
        agentToken,
        created: wasCreated,
      });
    }),
  );

  // 3. POST /users — sign up + mark verified; generate password if omitted.
  addRoute("POST", "/api/v1/paperclip/admin/users", withPaperclipErrors(async ({ res, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const email = requireString(b.email, "email");
    const name = requireString(b.name, "name");
    const providedPassword =
      typeof b.password === "string" && b.password.length > 0
        ? b.password
        : null;
    const password = providedPassword ?? generateStrongPassword();
    const loginUrl = `${paperclipPublicUrl()}/sign-in`;

    const session = await establishSession();
    const signup = await session.call("POST", "/api/auth/sign-up/email", {
      name,
      email,
      password,
    });

    if (signup.status >= 200 && signup.status < 300) {
      const userId = extractUserId(signup.body);
      await markVerified(session, email);
      sendJson(res, 200, {
        userId,
        email,
        // Only surface the password we minted; if the caller supplied one,
        // echo it back so the contract response shape is stable (they
        // already know it).
        password,
        loginUrl,
        created: true,
      });
      return;
    }

    if (isExistsError(signup.status, signup.body)) {
      // Idempotent: the user already exists. We don't know/return their
      // password (never recoverable) — password:null, created:false.
      sendJson(res, 200, {
        userId: null,
        email,
        password: null,
        loginUrl,
        created: false,
      });
      return;
    }

    throw new ApiError(502, "PAPERCLIP_SIGNUP_FAILED", "paperclip user sign-up failed", {
      detail: bodyDetail(signup.body),
    });
  }));

  // 3b. POST /companies/:companyId/access — grant a registered user
  //     company-scoped membership so they can open /<COMPANY>/inbox/mine.
  //
  // Why this exists (#246): register-user (#3) creates a Better-Auth account
  // but it has NO membership of the company the bootstrap just stood up — the
  // company is owned by the seed identity. Logging in then shows "No company
  // access". This route grants the registered principal an *operator*
  // membership of the named company via Paperclip's instance-admin surface.
  //
  // Mechanism (discovered on a live tenant — see #246 comment):
  //   GET  /api/admin/users?query=<email>            → resolve the userId
  //   GET  /api/admin/users/<userId>/company-access  → current companyIds
  //   PUT  /api/admin/users/<userId>/company-access  {companyIds:[...]}
  //     · Paperclip ADDS any new id (membershipRole "operator", status
  //       "active") and ARCHIVES any company NOT in the list. It is a
  //       full-set REPLACE — so we UNION the target id with the user's
  //       existing companyIds, never shrinking their access.
  //
  // Auth: the seed cookie session is an INSTANCE ADMIN — accepting the
  // bootstrap_ceo invite (bootstrap-paperclip.sh step 7) calls
  // promoteInstanceAdmin server-side — so it clears assertInstanceAdmin on
  // the /api/admin/* routes. If a tenant's seed account somehow isn't an
  // instance admin, those calls 401/403 and we surface 502 (the caller can
  // fall back to the manual invite path).
  //
  // Idempotent: re-running with the same (email, companyId) is a no-op (the
  // union already contains the id) → granted:true, alreadyMember:true.
  addRoute(
    "POST",
    "/api/v1/paperclip/admin/companies/:companyId/access",
    withPaperclipErrors(async ({ res, params, body }) => {
      const companyId = requireString(params.companyId, "companyId");
      const b = (body ?? {}) as Record<string, unknown>;
      const email = requireString(b.email, "email");
      const session = await establishSession();

      // 1. Resolve the user id from their email. /api/admin/users?query=<q>
      //    filters name+email substrings; we match the exact email
      //    (case-insensitive) so a substring collision can't pick the wrong
      //    account.
      const userId = await resolveUserIdByEmail(session, email);
      if (!userId) {
        // The principal hasn't been registered yet (call register_user
        // first). 404 is the honest signal — distinct from a Paperclip 502.
        throw new ApiError(
          404,
          "PAPERCLIP_USER_NOT_FOUND",
          "no paperclip user with that email — register the user first",
          { detail: email },
        );
      }

      // 2. Read current company access so the PUT (a full-set replace)
      //    doesn't archive any membership the user already has.
      const existingIds = await loadUserCompanyIds(session, userId);
      const alreadyMember = existingIds.includes(companyId);
      const target = alreadyMember
        ? existingIds
        : [...existingIds, companyId];

      // 3. PUT the union. Even when alreadyMember, we re-PUT the same set —
      //    it's a no-op server-side and keeps the response shape uniform.
      const put = await session.call(
        "PUT",
        `/api/admin/users/${encodeURIComponent(userId)}/company-access`,
        { companyIds: target },
      );
      if (put.status < 200 || put.status >= 300) {
        throw new ApiError(
          502,
          "PAPERCLIP_GRANT_FAILED",
          "paperclip company-access grant failed",
          { detail: bodyDetail(put.body) },
        );
      }

      sendJson(res, 200, {
        userId,
        companyId,
        granted: true,
        alreadyMember,
      });
    }),
  );

  // 4. GET /companies — read-back.
  addRoute("GET", "/api/v1/paperclip/admin/companies", withPaperclipErrors(async ({ res }) => {
    const session = await establishSession();
    const list = await session.call("GET", "/api/companies/", null);
    if (list.status >= 400) {
      throw new ApiError(502, "PAPERCLIP_LOOKUP_FAILED", "paperclip company list failed", {
        detail: bodyDetail(list.body),
      });
    }
    const companies = asList(list.body)
      .filter((c) => typeof c.id === "string")
      .map((c) => ({ id: c.id as string, name: (c.name as string) ?? "" }));
    sendJson(res, 200, { companies });
  }));

  // 5. GET /companies/:companyId/agents — read-back.
  addRoute(
    "GET",
    "/api/v1/paperclip/admin/companies/:companyId/agents",
    withPaperclipErrors(async ({ res, params }) => {
      const companyId = requireString(params.companyId, "companyId");
      const session = await establishSession();
      const list = await session.call(
        "GET",
        `/api/companies/${encodeURIComponent(companyId)}/agents`,
        null,
      );
      if (list.status >= 400) {
        throw new ApiError(502, "PAPERCLIP_LOOKUP_FAILED", "paperclip agent list failed", {
          detail: bodyDetail(list.body),
        });
      }
      const agents = asList(list.body)
        .filter((a) => typeof a.id === "string")
        .map((a) => ({
          id: a.id as string,
          name: (a.name as string) ?? "",
          role: (a.role as string) ?? "",
        }));
      sendJson(res, 200, { agents });
    }),
  );
}

/** Pull a user id out of a Better-Auth sign-up response. Tolerates both the
 *  flat {user:{id}} and a bare {id} shape. */
function extractUserId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const user = b.user;
  if (typeof user === "object" && user !== null) {
    const id = (user as Record<string, unknown>).id;
    if (typeof id === "string" && id) return id;
  }
  if (typeof b.id === "string" && b.id) return b.id;
  return null;
}

/** Best-effort "mark this identity verified" — tenants have no mailer so a
 *  fresh sign-up would otherwise sit unverified. Paperclip exposes an
 *  admin verify endpoint; a failure here is non-fatal (the principal can
 *  still sign in / be verified out of band), so we swallow errors. */
async function markVerified(
  session: PaperclipSession,
  email: string,
): Promise<void> {
  try {
    await session.call("POST", "/api/admin/verify-email", { email });
  } catch {
    /* non-fatal — no mailer; verification may be a no-op on this build */
  }
}

/** Resolve a Paperclip user id from their email via the instance-admin
 *  user-search endpoint. `query` does a substring match across name+email,
 *  so we filter the returned page down to an EXACT (case-insensitive) email
 *  match — a substring collision must never grant the wrong account access.
 *  Returns null when no user with that email exists (caller → 404). Throws
 *  502 on a Paperclip error so a flaky board fails loudly. */
async function resolveUserIdByEmail(
  session: PaperclipSession,
  email: string,
): Promise<string | null> {
  const resp = await session.call(
    "GET",
    `/api/admin/users?query=${encodeURIComponent(email)}`,
    null,
  );
  if (resp.status < 200 || resp.status >= 300) {
    throw new ApiError(
      502,
      "PAPERCLIP_USER_LOOKUP_FAILED",
      "paperclip user lookup failed",
      { detail: bodyDetail(resp.body) },
    );
  }
  const want = email.trim().toLowerCase();
  for (const u of asList(resp.body)) {
    const e = u.email;
    const id = u.id;
    if (
      typeof e === "string" &&
      e.toLowerCase() === want &&
      typeof id === "string" &&
      id
    ) {
      return id;
    }
  }
  return null;
}

/** Read a user's CURRENT active company memberships (the company ids) via
 *  GET /api/admin/users/<id>/company-access. The response is
 *  `{user, companyAccess:[{companyId, status, ...}]}`. We need this because
 *  setUserCompanyAccess (the PUT) is a full-set REPLACE — passing only the
 *  new id would archive every other membership. Returns the de-duped list
 *  of company ids the user already belongs to. Throws 502 on error. */
async function loadUserCompanyIds(
  session: PaperclipSession,
  userId: string,
): Promise<string[]> {
  const resp = await session.call(
    "GET",
    `/api/admin/users/${encodeURIComponent(userId)}/company-access`,
    null,
  );
  if (resp.status < 200 || resp.status >= 300) {
    throw new ApiError(
      502,
      "PAPERCLIP_ACCESS_LOOKUP_FAILED",
      "paperclip company-access lookup failed",
      { detail: bodyDetail(resp.body) },
    );
  }
  const out = new Set<string>();
  let rows: Record<string, unknown>[] = [];
  if (typeof resp.body === "object" && resp.body !== null) {
    const ca = (resp.body as Record<string, unknown>).companyAccess;
    if (Array.isArray(ca)) {
      rows = ca.filter(
        (x): x is Record<string, unknown> =>
          typeof x === "object" && x !== null,
      );
    }
  }
  for (const row of rows) {
    const cid = row.companyId;
    if (typeof cid === "string" && cid) out.add(cid);
  }
  return [...out];
}
