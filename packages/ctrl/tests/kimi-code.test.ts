/**
 * Targeted tests for the Kimi Code (Moonshot) credential + model picker
 * additions.
 *
 * Verifies:
 *   1. credentials.ts declares a KIMI_API_KEY entry in KNOWN_CREDENTIALS
 *      with the expected label.
 *   2. models.ts declares the Kimi catalog (kimi/kimi-code + kimi/k2p5),
 *      dispatches it on KIMI_API_KEY presence, and exports the cache
 *      invalidator hooked up by the credentials PATCH handler.
 *
 * These are source-level smoke checks: ctrl-api routes are tightly coupled
 * to the on-disk .env at /opt/alfred/compose/.env which doesn't exist in CI,
 * so we assert on the source rather than spinning up the full server.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROUTES_DIR = path.join(process.cwd(), "src", "api", "routes");

describe("KNOWN_CREDENTIALS includes Kimi Code", () => {
  const src = fs.readFileSync(path.join(ROUTES_DIR, "credentials.ts"), "utf-8");

  it("declares a KIMI_API_KEY entry", () => {
    assert.ok(
      src.includes('key: "KIMI_API_KEY"'),
      "credentials.ts must declare a KIMI_API_KEY entry in KNOWN_CREDENTIALS",
    );
  });

  it("labels the entry 'Kimi Code'", () => {
    assert.ok(
      src.includes('label: "Kimi Code"'),
      "credentials.ts must label the entry 'Kimi Code'",
    );
  });

  it("calls invalidateModelCatalogCache after PATCH writes .env", () => {
    assert.ok(
      src.includes("invalidateModelCatalogCache"),
      "credentials.ts must invalidate the model catalog cache on PATCH",
    );
  });
});

describe("models.ts Kimi catalog", () => {
  const src = fs.readFileSync(path.join(ROUTES_DIR, "models.ts"), "utf-8");

  it("declares kimi/kimi-code in the catalog", () => {
    assert.ok(src.includes('id: "kimi/kimi-code"'), "kimi/kimi-code missing from catalog");
  });

  it("declares kimi/k2p5 in the catalog", () => {
    assert.ok(src.includes('id: "kimi/k2p5"'), "kimi/k2p5 (legacy id) missing from catalog");
  });

  it("dispatches fetchKimiModels when KIMI_API_KEY is present", () => {
    assert.ok(
      src.includes('keys.has("KIMI_API_KEY")'),
      "models.ts must check for KIMI_API_KEY in fetchAllModels",
    );
    assert.ok(
      src.includes("fetchKimiModels"),
      "models.ts must define a fetchKimiModels fetcher",
    );
  });

  it("includes 'kimi' in the direct-model dedupe regex", () => {
    assert.ok(
      src.includes("openai|anthropic|google|x-ai|kimi"),
      "groupModels regex must include kimi so kimi/* model ids dedupe correctly",
    );
  });

  it("exports invalidateModelCatalogCache", () => {
    assert.ok(
      src.includes("export function invalidateModelCatalogCache"),
      "models.ts must export invalidateModelCatalogCache for the credentials PATCH handler",
    );
  });
});
