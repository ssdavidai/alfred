// vaultwarden-bootstrap-signup.mjs — implements the Bitwarden registration
// crypto and POSTs /api/accounts/register against the local Vaultwarden so
// Sir's account is fully provisioned without any browser interaction.
//
// Why this is necessary: Vaultwarden's /admin API has no "create user with
// password" endpoint — it only has /admin/invite (creates an Invitation +
// pending User). The user-facing /api/accounts/register handler accepts the
// same payload the web vault submits during signup; with a pending Invitation
// already in place, registration succeeds even with SIGNUPS_ALLOWED=false.
//
// We replicate the client-side crypto here:
//   * masterKey = PBKDF2-SHA256(masterPassword, lowercased(email), iterations, 32)
//   * masterPasswordHash = PBKDF2-SHA256(masterKey, masterPassword, 1, 32) → base64
//   * stretchedMasterEnc = HKDF-Expand-SHA256(masterKey, "enc", 32)
//   * stretchedMasterMac = HKDF-Expand-SHA256(masterKey, "mac", 32)
//   * userKey = 64 random bytes (32 enc + 32 mac)
//   * encryptedUserKey = EncString_2(userKey, stretchedMasterEnc, stretchedMasterMac)
//   * RSA-2048 keypair (PKCS8 + SPKI DER)
//   * encryptedPrivateKey = EncString_2(privateKey, userKey[0:32], userKey[32:64])
//   * POST /api/accounts/register { ...all of the above }
//
// EncString format (Bitwarden type 2 = AesCbc256_HmacSha256_B64):
//   "2.<iv-b64>|<ct-b64>|<mac-b64>"
//
// Validation: we end by exec'ing `bw login email password --raw` against the
// same Vaultwarden URL. If the session token comes back, the account is
// fully usable. If anything fails, we exit non-zero and the caller can fall
// back to manual web-UI signup.
//
// Inputs (env):
//   BW_USER, BW_PASSWORD, BW_SERVER_URL — same shape vault-init uses
//   VAULTWARDEN_NAME (optional)         — display name (default "Sir")
//   KDF_ITERATIONS (optional)           — PBKDF2 rounds (default 600000)
//
// Exit codes:
//   0  account exists + bw login succeeded
//   2  registration POST returned non-2xx (Vaultwarden rejected the payload)
//   3  bw login validation failed after registration succeeded (would indicate
//      a crypto bug — should not happen if registration was 200)
//   4  configuration error

import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const KDF_ITERATIONS = Number(process.env.KDF_ITERATIONS ?? "600000");

function fatal(code, msg) {
  console.error(`[bootstrap-signup] FATAL: ${msg}`);
  process.exit(code);
}

const email = (process.env.BW_USER ?? "").toLowerCase();
const password = process.env.BW_PASSWORD ?? "";
const serverUrl = (process.env.BW_SERVER_URL ?? "").replace(/\/+$/, "");
const name = process.env.VAULTWARDEN_NAME ?? "Sir";

if (!email) fatal(4, "BW_USER unset");
if (!password) fatal(4, "BW_PASSWORD unset");
if (!serverUrl) fatal(4, "BW_SERVER_URL unset");

console.error(`[bootstrap-signup] target=${serverUrl} user=${email} kdf=${KDF_ITERATIONS}`);

// ── 1. Derive master key + master password hash ──
//
// PBKDF2(password, salt=email, iterations, dkLen=32) — exact shape Bitwarden
// uses since 2023; iteration count is configurable per-account. We default to
// the current Bitwarden web vault default of 600000.
const masterKey = crypto.pbkdf2Sync(
  Buffer.from(password, "utf8"),
  Buffer.from(email, "utf8"),
  KDF_ITERATIONS,
  32,
  "sha256",
);
const masterPasswordHash = crypto
  .pbkdf2Sync(masterKey, Buffer.from(password, "utf8"), 1, 32, "sha256")
  .toString("base64");

// ── 2. Stretch master key into (encKey, macKey) via HKDF-Expand ──
//
// Bitwarden uses HKDF-Expand directly (no Extract step) treating the
// master key as the PRK. info="enc" produces the AES key; info="mac"
// produces the HMAC key. RFC 5869, with output length 32 → one block,
// so T(1) = HMAC(prk, T(0) || info || 0x01) and we take all 32 bytes.
function hkdfExpand(prk, info, length) {
  const blocks = Math.ceil(length / 32);
  let t = Buffer.alloc(0);
  let okm = Buffer.alloc(0);
  for (let i = 1; i <= blocks; i++) {
    const h = crypto.createHmac("sha256", prk);
    h.update(t);
    h.update(info);
    h.update(Buffer.from([i]));
    t = h.digest();
    okm = Buffer.concat([okm, t]);
  }
  return okm.subarray(0, length);
}
const stretchedMasterEnc = hkdfExpand(masterKey, Buffer.from("enc", "utf8"), 32);
const stretchedMasterMac = hkdfExpand(masterKey, Buffer.from("mac", "utf8"), 32);

// ── 3. EncString helper (type 2 = AesCbc256_HmacSha256_B64) ──
//
// Format: "2.<iv-b64>|<ct-b64>|<mac-b64>"
//   iv     — 16 random bytes
//   ct     — AES-256-CBC(encKey, iv, plaintext) with PKCS#7 padding
//   mac    — HMAC-SHA256(macKey, iv || ct), 32 bytes
function encryptEncString(plaintext, encKey, macKey) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", encKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = crypto.createHmac("sha256", macKey).update(iv).update(ct).digest();
  return `2.${iv.toString("base64")}|${ct.toString("base64")}|${mac.toString("base64")}`;
}

// ── 4. Generate user key (CipherKey) and encrypt with stretched master ──
//
// User key is 64 random bytes — first 32 are the AES enc key, last 32 are
// the HMAC mac key. The web vault treats this as the source of truth for
// every other vault item's encryption.
const userKey = crypto.randomBytes(64);
const userEncKey = userKey.subarray(0, 32);
const userMacKey = userKey.subarray(32, 64);
const encryptedUserKey = encryptEncString(userKey, stretchedMasterEnc, stretchedMasterMac);

// ── 5. RSA-2048 keypair, encrypt private key with user key ──
//
// publicKey:  SPKI DER, base64
// privateKey: PKCS8 DER, encrypted with the user key as EncString
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "der" },
});
const encryptedPrivateKey = encryptEncString(privateKey, userEncKey, userMacKey);

// ── 6. POST /api/accounts/register ──
const registerPayload = {
  name,
  email,
  masterPasswordHash,
  masterPasswordHint: null,
  key: encryptedUserKey,
  keys: {
    encryptedPrivateKey,
    publicKey: publicKey.toString("base64"),
  },
  kdf: 0,                   // PBKDF2-SHA256
  kdfIterations: KDF_ITERATIONS,
  kdfMemory: null,
  kdfParallelism: null,
  // Vaultwarden ignores referenceData / captchaResponse but the web vault
  // sends them; include nulls for parity.
  referenceData: null,
  captchaResponse: null,
};

console.error(
  `[bootstrap-signup] POSTing /api/accounts/register (${JSON.stringify(registerPayload).length} bytes)`,
);
const resp = await fetch(`${serverUrl}/api/accounts/register`, {
  method: "POST",
  headers: { "content-type": "application/json", "device-type": "21" /* SDK */ },
  body: JSON.stringify(registerPayload),
});
const respText = await resp.text();
if (!resp.ok) {
  // Vaultwarden returns 400 with a JSON body if the email is already
  // registered — interpret as success-equivalent (idempotent run).
  if (resp.status === 400 && /already (exists|registered)/i.test(respText)) {
    console.error(`[bootstrap-signup] account already exists; treating as idempotent success`);
  } else {
    console.error(`[bootstrap-signup] register HTTP ${resp.status}: ${respText.slice(0, 500)}`);
    fatal(2, `register failed`);
  }
} else {
  console.error(`[bootstrap-signup] register HTTP ${resp.status}: ${respText.slice(0, 200) || "ok"}`);
}

// ── 7. Validate by `bw login` ──
//
// If the crypto was right, bw login should authenticate end-to-end. We use
// execFileSync because we don't need streaming and the bw process is short.
console.error(`[bootstrap-signup] verifying with bw login`);
try {
  // Configure bw to point at the same server.
  execFileSync("bw", ["config", "server", serverUrl], { stdio: ["ignore", "ignore", "inherit"] });
  // bw login may report "already logged in" if a previous run authenticated;
  // we run logout first to keep this script idempotent.
  try {
    execFileSync("bw", ["logout"], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    // no-op — was already logged out
  }
  const session = execFileSync("bw", ["login", email, password, "--raw"], {
    stdio: ["ignore", "pipe", "inherit"],
  })
    .toString("utf8")
    .trim();
  if (!session || session.length < 16) {
    fatal(3, `bw login returned empty/short session`);
  }
  console.error(`[bootstrap-signup] bw login OK (session length ${session.length})`);
} catch (e) {
  fatal(3, `bw login validation failed: ${e?.message ?? e}`);
}

console.log(JSON.stringify({ ok: true, email, server: serverUrl }));
