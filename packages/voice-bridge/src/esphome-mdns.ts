// esphome-mdns.ts — advertise voice-bridge as `_esphomelib._tcp.local.` so
// HA's ESPHome integration auto-discovers us. See spec §5.2.
//
// We use `bonjour-service` (a TypeScript Bonjour/Zeroconf implementation, no
// native deps — pure JS) because it's the only Node mDNS library that works
// out of the box on slim Docker images without libavahi. The classic `mdns`
// package binds to libdns_sd / Avahi and is a non-starter inside our
// node:22-slim base.
//
// IMPORTANT — Docker networking gotcha (see spec §4 docker-compose row):
//   mDNS uses UDP multicast on 224.0.0.251:5353. The default Docker bridge
//   network does not pass multicast through to the host LAN, so this
//   advertisement is only visible to other containers on the same bridge
//   network until the operator either (a) flips the voice-bridge service
//   to `network_mode: host` or (b) runs an Avahi reflector on the host.
//   PR1 ships the advertiser anyway — it's a no-op when nobody can see it,
//   and it lights up the moment the operator addresses the networking. The
//   HACS integration that lands in PR4 offers a "Connect by hostname"
//   fallback for the multicast-can't-cross-bridge case.
//
// We make the publication best-effort: if bonjour-service is unavailable
// (e.g. optional dep didn't install on the slim base image) or throws on
// startup (e.g. inside a network namespace where 5353/udp is closed), we log
// + carry on. The TCP listener on :6053 is the load-bearing path; mDNS is
// just a convenience.

import type { EsphomeServerIdentity } from "./esphome-server.js";

export interface MdnsAnnounceOptions {
  port: number;
  identity: EsphomeServerIdentity;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface MdnsHandle {
  stop(): Promise<void>;
}

function defaultLog(msg: string, extra?: Record<string, unknown>): void {
  if (extra) console.log(`[esphome-mdns] ${msg}`, extra);
  else console.log(`[esphome-mdns] ${msg}`);
}

export async function announceEsphomeMdns(opts: MdnsAnnounceOptions): Promise<MdnsHandle> {
  const log = opts.log ?? defaultLog;

  // Lazy import — bonjour-service is an optional runtime dep. If installation
  // failed (e.g. on a slim base image without dgram support) we still want
  // voice-bridge to boot and serve TCP. The dynamic import lets us fall back
  // cleanly. We tolerate either `bonjour-service` (ESM export) or fall
  // through silently when missing.
  let bonjourModule: unknown;
  try {
    // The import path is wrapped in a runtime string concat to keep the
    // TypeScript compiler from requiring the module's types at build time —
    // the package is optional and may not be installed in CI.
    const modName = "bonjour-service";
    bonjourModule = await import(modName);
  } catch (err) {
    log("bonjour-service unavailable — mDNS announcement skipped", {
      err: err instanceof Error ? err.message : String(err),
    });
    return { stop: async () => {} };
  }

  // The package exports both as a named `Bonjour` and as a default. Tolerate
  // both shapes so a future bump doesn't break us.
  const ctor =
    (bonjourModule as { Bonjour?: unknown }).Bonjour ??
    (bonjourModule as { default?: { Bonjour?: unknown } }).default?.Bonjour;
  if (!ctor || typeof ctor !== "function") {
    log("bonjour-service shape unexpected — mDNS announcement skipped");
    return { stop: async () => {} };
  }

  type BonjourInstance = {
    publish: (opts: object) => unknown;
    destroy: () => void;
  };
  let instance: BonjourInstance;
  try {
    instance = new (ctor as new () => BonjourInstance)();
  } catch (err) {
    log("bonjour-service init failed — mDNS announcement skipped", {
      err: err instanceof Error ? err.message : String(err),
    });
    return { stop: async () => {} };
  }

  // The TXT records here mirror what a real ESPHome device publishes (cf.
  // esphome/components/api/api_mdns.cpp). HA's ESPHome integration parses
  // these on discovery to pre-populate the Add Integration dialog.
  const txt: Record<string, string> = {
    version: opts.identity.esphomeVersion,
    mac: opts.identity.macAddress.replace(/:/g, ""),
    platform: "alfred",
    board: opts.identity.name,
    network: "ethernet",
    friendly_name: opts.identity.friendlyName,
    project_name: opts.identity.projectName,
    project_version: opts.identity.projectVersion,
  };

  try {
    instance.publish({
      name: opts.identity.friendlyName,
      type: "esphomelib",
      port: opts.port,
      txt,
    });
    log("mDNS announce published", {
      service: "_esphomelib._tcp.local.",
      port: opts.port,
      friendly_name: opts.identity.friendlyName,
    });
  } catch (err) {
    log("mDNS publish failed (continuing)", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    stop: async () => {
      try {
        instance.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}
