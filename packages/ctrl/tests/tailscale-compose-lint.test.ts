// Issue #109 PR 1 — Tailscale sidecar foundation lint.
//
// The PR ships a single load-bearing contract: the `tailscale` service is
// declared in the repo's docker-compose.yaml but is OFF on every fresh
// tenant. PR 3 will let the principal turn it on from /connections; until
// then NOTHING about an existing tenant should change. This test reads
// the docker-compose.yaml as YAML and asserts the structural invariants
// that uphold that promise.
//
// The CI `compose-lint` job in .github/workflows/ci-check.yml runs the
// same assertions end-to-end through the docker-compose CLI; this unit
// test is the fast, docker-free version that catches regressions during
// `npm test`.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import yaml from "js-yaml";

const COMPOSE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docker-compose.yaml",
);

interface ServiceSpec {
  image?: string;
  profiles?: string[];
  hostname?: string;
  environment?: Record<string, string> | string[];
  volumes?: (string | { source?: string; target?: string })[];
  cap_add?: string[];
  restart?: string;
  // Loose for forward-compat.
  [key: string]: unknown;
}

interface ComposeFile {
  services: Record<string, ServiceSpec>;
  volumes: Record<string, unknown>;
}

const compose = yaml.load(readFileSync(COMPOSE_PATH, "utf-8")) as ComposeFile;

function envMap(svc: ServiceSpec): Record<string, string> {
  const env = svc.environment;
  if (!env) return {};
  if (Array.isArray(env)) {
    const out: Record<string, string> = {};
    for (const kv of env) {
      const eq = kv.indexOf("=");
      if (eq < 0) continue;
      out[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    return out;
  }
  return env as Record<string, string>;
}

describe("tailscale sidecar — compose-foundation lint (issue #109 PR 1)", () => {
  it("the `tailscale` service is declared", () => {
    assert.ok(
      compose.services.tailscale,
      "docker-compose.yaml must declare a `tailscale` service",
    );
  });

  it("uses the official tailscale/tailscale:stable image", () => {
    const svc = compose.services.tailscale;
    assert.equal(
      svc.image,
      "tailscale/tailscale:stable",
      "image must be the vendor-supported tailscale/tailscale:stable",
    );
  });

  it("is profile-gated — OFF unless `--profile tailscale` is passed", () => {
    // This is the entire "existing tenants see zero change" promise. A
    // service without `profiles:` runs under `docker compose up -d`; this
    // service must NEVER do that.
    const svc = compose.services.tailscale;
    assert.deepEqual(
      svc.profiles,
      ["tailscale"],
      "profiles MUST be exactly ['tailscale'] — empty/missing would start " +
        "the sidecar by default on every tenant deploy",
    );
  });

  it("no OTHER default-profile service silently gained a tailscale profile", () => {
    // Defensive: catch a refactor that accidentally tags an existing
    // service with profile:[tailscale] (which would break it on default
    // `docker compose up -d`).
    const allowed = new Set(["tailscale"]);
    for (const [name, svc] of Object.entries(compose.services)) {
      const profiles = svc.profiles ?? [];
      if (profiles.includes("tailscale") && !allowed.has(name)) {
        assert.fail(
          `service ${name} unexpectedly has the 'tailscale' profile — ` +
            "every other service must be either default-profile or under " +
            "an unrelated profile.",
        );
      }
    }
  });

  it("derives hostname from TAILSCALE_HOSTNAME_PREFIX with $DOMAIN fallback", () => {
    // Compose interpolation does NOT support Bash ${VAR//./-}, so the
    // dot-to-dash rule from spec §3.2.1 lives in scripts/bootstrap.sh; the
    // compose file just consumes the derived TAILSCALE_HOSTNAME_PREFIX,
    // with a defensive ${DOMAIN} fallback.
    const svc = compose.services.tailscale;
    const expected = "${TAILSCALE_HOSTNAME_PREFIX:-${DOMAIN}}";
    assert.equal(svc.hostname, expected, "hostname must be the documented expression");
    const env = envMap(svc);
    assert.equal(env.TS_HOSTNAME, expected, "TS_HOSTNAME must mirror the hostname expression");
  });

  it("passes TAILSCALE_AUTHKEY (with empty default) for path-A bootstrap", () => {
    // Path C (device-auth URL) is the recommended flow; path A is a
    // collapsed advanced fallback. Both rely on the same env wiring.
    const env = envMap(compose.services.tailscale);
    assert.equal(
      env.TS_AUTHKEY,
      "${TAILSCALE_AUTHKEY:-}",
      "TS_AUTHKEY must default to empty so the device-auth URL flow is the default",
    );
  });

  it("runs in kernel mode (TS_USERSPACE=false)", () => {
    // Userspace mode forfeits kernel-routed MagicDNS resolution from peer
    // containers — the whole point of the "Alfred can reach
    // homeassistant.tail-id.ts.net" experience. Spec §3.2 (rejected).
    const env = envMap(compose.services.tailscale);
    assert.equal(
      env.TS_USERSPACE,
      "false",
      "TS_USERSPACE must be 'false' so kernel-routed MagicDNS works for peer containers",
    );
  });

  it("conditionally advertises tags only when TAILSCALE_TAGS is set", () => {
    // The empty-by-default tag is the resolution of Q4: don't ship a
    // default `tag:alfred-tenant` because the principal's tailnet ACL
    // hasn't declared it. `${VAR:+...}` expands to nothing when the var
    // is empty.
    const env = envMap(compose.services.tailscale);
    assert.equal(
      env.TS_EXTRA_ARGS,
      "--accept-routes ${TAILSCALE_TAGS:+--advertise-tags=${TAILSCALE_TAGS}}",
      "TS_EXTRA_ARGS must use ${TAGS:+...} so the flag disappears when blank",
    );
  });

  it("has the kernel capabilities the WireGuard backend requires", () => {
    const svc = compose.services.tailscale;
    const caps = svc.cap_add ?? [];
    for (const required of ["NET_ADMIN", "NET_RAW"]) {
      assert.ok(
        caps.includes(required),
        `cap_add must include ${required} for kernel-mode tailscaled`,
      );
    }
  });

  it("mounts /var/lib/tailscale on the `tailscale_data` named volume", () => {
    // tailscaled.state lives here. Surviving `docker compose pull` is the
    // whole point — the principal's node key persists across image updates
    // so reconnection is a no-op on Tailscale's side.
    const svc = compose.services.tailscale;
    const vols = (svc.volumes ?? []).map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
    const stateMount = vols.find((v) => v.includes("/var/lib/tailscale"));
    assert.ok(stateMount, "must mount /var/lib/tailscale");
    assert.ok(
      stateMount?.startsWith("tailscale_data:"),
      "/var/lib/tailscale must be backed by the tailscale_data named volume",
    );
    const tunMount = vols.find((v) => v.includes("/dev/net/tun"));
    assert.ok(tunMount, "must bind-mount /dev/net/tun for kernel WireGuard");
  });

  it("the `tailscale_data` named volume is declared at top level", () => {
    assert.ok(
      Object.hasOwn(compose.volumes, "tailscale_data"),
      "tailscale_data must be in the top-level volumes: block",
    );
  });

  it("restart policy is unless-stopped (matches every other long-lived service)", () => {
    assert.equal(compose.services.tailscale.restart, "unless-stopped");
  });
});
