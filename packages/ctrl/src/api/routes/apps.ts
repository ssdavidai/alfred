import http from "node:http";
import { URL } from "node:url";
import { addRoute } from "../server.js";
import { sendJson } from "../errors.js";

type AppStatus = "up" | "down";

interface InstalledApp {
  id: string;
  name: string;
  url: string | null;
  icon: string;
  status: AppStatus;
}

async function checkHealth(
  url: string,
  opts: { host?: string } = {},
): Promise<AppStatus> {
  // Some apps (Paperclip, anything behind a "trusted origins" middleware)
  // 403 requests whose Host header doesn't match the configured public
  // hostname — internal probes via compose DNS (paperclip:3100) trip that
  // check. `opts.host` lets the caller override the Host header so the
  // probe carries the app's real production hostname while still hitting
  // the compose-internal address.
  //
  // Node's built-in fetch (undici) silently drops manual Host headers
  // because it reserves Host from the URL itself. For the Host-override
  // case we fall back to node:http directly. Plane/Sure/Vault use the
  // fast-path (fetch, no header override) — they don't have trusted-
  // origins guards.
  if (opts.host) {
    return await checkHealthWithHost(url, opts.host);
  }
  try {
    const resp = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok ? "up" : "down";
  } catch {
    return "down";
  }
}

function checkHealthWithHost(url: string, host: string): Promise<AppStatus> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return resolve("down");
    }
    const req = http.request(
      {
        method: "GET",
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        headers: { Host: host },
        timeout: 2000,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.resume(); // drain
        resolve(status >= 200 && status < 400 ? "up" : "down");
      },
    );
    req.on("error", () => resolve("down"));
    req.on("timeout", () => {
      req.destroy();
      resolve("down");
    });
    req.end();
  });
}

export function registerAppsRoutes(): void {
  addRoute("GET", "/api/v1/apps", async ({ res }) => {
    // Merged single-VM stack: Caddy routes the apex subdomains
    // plane.{$DOMAIN} → plane-proxy:80, sure.{$DOMAIN} → sure-web:3000,
    // vault.{$DOMAIN} → vaultwarden:80 (see deploy/caddy/Caddyfile). The old
    // TENANT_SUBDOMAIN/TENANT_DOMAIN scheme ({subdomain}-{app}.{domain}) is
    // unset here, so build off DOMAIN — the env ctrl-api actually has (same
    // var claudeSetup.ts uses for mcp.{$DOMAIN}). Fall back to TENANT_DOMAIN,
    // then the apex default, so URLs resolve to the real host (e.g.
    // test.alfred.black) rather than the bare alfred.black default.
    const domain = process.env.DOMAIN || process.env.TENANT_DOMAIN || "alfred.black";

    const checks: Array<Promise<InstalledApp>> = [];

    // Plane / Sure / Vault are always-on in the merged stack — surface them
    // unconditionally. The runtime (Hermes, formerly OpenClaw) is reached via
    // the in-app /chat thin client the web adds separately; it is NOT a dock
    // app, so no openclaw/chat entry here.
    checks.push(
      (async (): Promise<InstalledApp> => ({
        id: "plane",
        name: "Plane",
        url: `https://plane.${domain}`,
        icon: "/app-icons/plane.svg",
        status: await checkHealth("http://plane-proxy:80/"),
      }))(),
    );

    checks.push(
      (async (): Promise<InstalledApp> => ({
        id: "sure",
        name: "Sure",
        url: `https://sure.${domain}`,
        icon: "/app-icons/sure.svg",
        status: await checkHealth("http://sure-web:3000/up"),
      }))(),
    );

    checks.push(
      (async (): Promise<InstalledApp> => ({
        id: "vault",
        name: "Vaultwarden",
        url: `https://vault.${domain}`,
        icon: "/app-icons/vaultwarden.svg",
        status: await checkHealth("http://vaultwarden:80/alive"),
      }))(),
    );

    // Paperclip — the company simulation (paperclip.ing). Alfred runs as
    // a "managed employee" here; the principal sees companies / employees
    // / issues / boards. Always-on per Sir 2026-05-26.
    //
    // Health probe: /sign-in (Paperclip's unauthenticated entry page,
    // returns 200). The web-root '/' returns 403 — better-auth rejects
    // unauthed visits before the React shell renders.
    //
    // Host-header override: Paperclip 403s requests whose Host doesn't
    // match its PAPERCLIP_PUBLIC_URL hostname (trusted-origins guard).
    // We hit compose DNS but carry the public Host so the guard accepts.
    checks.push(
      (async (): Promise<InstalledApp> => ({
        id: "paperclip",
        name: "Paperclip",
        url: `https://paperclip.${domain}`,
        icon: "/app-icons/paperclip.svg",
        status: await checkHealth("http://paperclip:3100/sign-in", {
          host: `paperclip.${domain}`,
        }),
      }))(),
    );

    // (The meeting-transcript dashboard tile was retired in #113 PR1
    // — the upstream stack is gone. Recall.ai's replacement, when it
    // ships in #113 PR2+, lives on /channels rather than /apps.)

    const apps = await Promise.all(checks);
    sendJson(res, 200, { apps });
  });
}
