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

async function checkHealth(url: string): Promise<AppStatus> {
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
