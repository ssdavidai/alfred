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
  // the compose-internal address. Plane/Sure/Vault don't need this.
  const headers: Record<string, string> = {};
  if (opts.host) headers.Host = opts.host;
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok ? "up" : "down";
  } catch {
    return "down";
  }
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

    // Vexa — meeting transcript dashboard (Steward Phase 4 — #840). Vexa
    // itself runs as a separate compose project at /opt/alfred/vexa/; the
    // ``vexa-dashboard`` service in that stack joins the alfred_default
    // network so ctrl-api can reach it at http://vexa-dashboard:3000.
    // Gate on VEXA_ENABLED=true (set in /opt/alfred/compose/.env by
    // setupVexa) — this keeps the dock clean for tenants who haven't
    // turned on the transcription stack yet.
    if (process.env.VEXA_ENABLED === "true") {
      checks.push(
        (async (): Promise<InstalledApp> => ({
          id: "vexa",
          name: "Vexa",
          url: `https://vexa.${domain}`,
          icon: "/app-icons/vexa.svg",
          status: await checkHealth("http://vexa-dashboard:3000/api/health"),
        }))(),
      );
    }

    const apps = await Promise.all(checks);
    sendJson(res, 200, { apps });
  });
}
