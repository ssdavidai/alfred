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
    const subdomain = process.env.TENANT_SUBDOMAIN || "";
    const domain = process.env.TENANT_DOMAIN || "alfred.black";

    const checks: Array<Promise<InstalledApp>> = [];

    checks.push(
      (async (): Promise<InstalledApp> => ({
        id: "openclaw",
        name: "OpenClaw",
        url: subdomain ? `https://${subdomain}.${domain}` : null,
        icon: "/app-icons/openclaw.svg",
        status: await checkHealth("http://openclaw:18789/health"),
      }))(),
    );

    if (process.env.PLANE_API_TOKEN) {
      checks.push(
        (async (): Promise<InstalledApp> => ({
          id: "plane",
          name: "Plane",
          url: subdomain ? `https://${subdomain}-plane.${domain}` : null,
          icon: "/app-icons/plane.svg",
          status: await checkHealth("http://plane-proxy:80/"),
        }))(),
      );
    }

    if (process.env.SURE_API_KEY) {
      checks.push(
        (async (): Promise<InstalledApp> => ({
          id: "sure",
          name: "Sure",
          url: subdomain ? `https://${subdomain}-sure.${domain}` : null,
          icon: "/app-icons/sure.svg",
          status: await checkHealth("http://sure-web:3000/up"),
        }))(),
      );
    }

    // Vaultwarden — present when this tenant has been migrated. We key off
    // BW_USER (the only Vaultwarden bootstrap value that's set the moment
    // setupVaultwarden runs) rather than VAULTWARDEN_ADMIN_TOKEN so the dock
    // surfaces correctly even on tenants where the operator has revoked the
    // admin token (BW_USER + BW_PASSWORD remain because vault-init still
    // needs them).
    if (process.env.BW_USER) {
      checks.push(
        (async (): Promise<InstalledApp> => ({
          id: "vaultwarden",
          name: "Vault",
          url: subdomain ? `https://${subdomain}-vault.${domain}` : null,
          icon: "/app-icons/vaultwarden.svg",
          status: await checkHealth("http://vaultwarden:80/alive"),
        }))(),
      );
    }

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
          url: subdomain ? `https://${subdomain}-vexa.${domain}` : null,
          icon: "/app-icons/vexa.svg",
          status: await checkHealth("http://vexa-dashboard:3000/api/health"),
        }))(),
      );
    }

    const apps = await Promise.all(checks);
    sendJson(res, 200, { apps });
  });
}
