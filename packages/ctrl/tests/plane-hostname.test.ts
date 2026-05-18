import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  generateSubdomain,
  planeHostnameFromCustomerName,
  planeSlug,
} from "../src/infra/plane-hostname.js";

// ---------------------------------------------------------------------------
// Regression guard for Plane webhook URL provisioning.
//
// The bug (surfaced on Sir 2026-04-23): setupPlane() built its webhook URL
// from `instance.subdomain` in ctrl-db, which had drifted to the pre-slug
// short form `alfred-david`. Cloudflare DNS + tunnel ingress were correctly
// `alfred-david-mnbqn4jg.alfred.black`, so the webhook registered in Plane
// pointed at an NXDOMAIN host. Plane auto-disabled it after 5 retries and
// reverse-sync silently stopped.
//
// Ground truth is `customer_name` (SaaS always generates it as
// `alfred-<slug>-<base36ts>`, matching what Acme Cloud + Cloudflare see). These
// tests pin every Plane-addressable value — webhook URL, admin email, alfred
// email, workspace slug — to that source.
// ---------------------------------------------------------------------------

describe("generateSubdomain", () => {
  it("is a lowercase-only identity on SaaS-shaped customer names", () => {
    assert.equal(
      generateSubdomain("alfred-david-mnbqn4jg"),
      "alfred-david-mnbqn4jg",
    );
    assert.equal(
      generateSubdomain("alfred-miguel-mnd9thwe"),
      "alfred-miguel-mnd9thwe",
    );
    assert.equal(
      generateSubdomain("alfred-tenant-a-zsolt-mnczdq7a"),
      "alfred-tenant-a-zsolt-mnczdq7a",
    );
  });

  it("lowercases mixed-case names", () => {
    assert.equal(generateSubdomain("Alfred-FOO-123"), "alfred-foo-123");
  });

  it("converts underscores to hyphens (DNS-safe)", () => {
    assert.equal(generateSubdomain("alfred_foo_123"), "alfred-foo-123");
  });
});

describe("planeSlug", () => {
  it("passes through SaaS-shaped subdomains unchanged", () => {
    assert.equal(planeSlug("alfred-david-mnbqn4jg"), "alfred-david-mnbqn4jg");
  });

  it("caps at 48 chars", () => {
    const long = "a".repeat(60);
    assert.equal(planeSlug(long).length, 48);
  });

  it("ensures at least 2 chars by prefixing `alfred-` on tiny input", () => {
    assert.equal(planeSlug("x"), "alfred-x");
  });
});

describe("planeHostnameFromCustomerName", () => {
  it("preserves the full Acme Cloud slug in the webhook URL", () => {
    const r = planeHostnameFromCustomerName("alfred-david-mnbqn4jg");
    assert.equal(r.hostname, "alfred-david-mnbqn4jg");
    assert.equal(
      r.webhookUrl,
      "https://alfred-david-mnbqn4jg.alfred.black/api/v1/plane/webhook",
    );
    assert.equal(r.adminEmail, "admin@alfred-david-mnbqn4jg.alfred.black");
    assert.equal(r.alfredEmail, "alfred@alfred-david-mnbqn4jg.alfred.black");
    // Workspace slug just collapses to the same hostname — no suffix trimming
    // as long as it's within Plane's 2–48 char bound.
    assert.equal(r.slug, "alfred-david-mnbqn4jg");
  });

  it("matches Cloudflare DNS for tenant-b + tenant-a", () => {
    assert.equal(
      planeHostnameFromCustomerName("alfred-miguel-mnd9thwe").webhookUrl,
      "https://alfred-miguel-mnd9thwe.alfred.black/api/v1/plane/webhook",
    );
    assert.equal(
      planeHostnameFromCustomerName("alfred-tenant-a-zsolt-mnczdq7a").webhookUrl,
      "https://alfred-tenant-a-zsolt-mnczdq7a.alfred.black/api/v1/plane/webhook",
    );
  });

  it("regression: does NOT drop the Acme Cloud slug when customer_name includes it", () => {
    // This is the exact scenario that broke Sir's Plane webhook. Before
    // the fix, setupPlane() read `opts.subdomain` which had the short form.
    // The helper now derives from customer_name so the slug is preserved.
    const r = planeHostnameFromCustomerName("alfred-david-mnbqn4jg");
    assert.notEqual(
      r.webhookUrl,
      "https://alfred-david.alfred.black/api/v1/plane/webhook",
      "webhook URL must not drop the Acme Cloud slug",
    );
    assert.ok(
      r.webhookUrl.includes("mnbqn4jg"),
      "webhook URL must include the Acme Cloud slug",
    );
  });

  it("accepts a custom domain (for dev / staging)", () => {
    const r = planeHostnameFromCustomerName(
      "alfred-test-xyz123",
      "alfred-staging.dev",
    );
    assert.equal(
      r.webhookUrl,
      "https://alfred-test-xyz123.alfred-staging.dev/api/v1/plane/webhook",
    );
  });
});
