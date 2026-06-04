#!/usr/bin/env tsx
export {};
// Manual / cron-safe trigger for the one-way Vaultwarden → Paperclip secret sync.
// Values never appear in this script's stdout; ctrl-api returns key names only.

const companyId = process.env.PAPERCLIP_SECRET_SYNC_COMPANY_ID || process.argv[2];
if (!companyId) {
  console.error("Usage: PAPERCLIP_SECRET_SYNC_COMPANY_ID=<company-id> AAS_API_KEY=<key> tsx scripts/paperclip-secret-sync.ts [company-id]");
  process.exit(2);
}

const base = (process.env.CTRL_API_URL || "http://ctrl-api:3100").replace(/\/+$/, "");
const apiKey = process.env.AAS_API_KEY || process.env.CTRL_API_KEY;
if (!apiKey) {
  console.error("AAS_API_KEY or CTRL_API_KEY is required");
  process.exit(2);
}

const dryRun = process.env.PAPERCLIP_SECRET_SYNC_DRY_RUN === "1" || process.argv.includes("--dry-run");
const url = `${base}/api/v1/paperclip/admin/companies/${encodeURIComponent(companyId)}/secrets/sync`;

const res = await fetch(url, {
  method: "POST",
  headers: {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ dry_run: dryRun }),
});
const text = await res.text();
let body: any = text;
try { body = text ? JSON.parse(text) : null; } catch {}
if (!res.ok) {
  console.error(JSON.stringify({ ok: false, status: res.status, error: body }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(body, null, 2));
