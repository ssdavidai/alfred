import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.VOICE_BRIDGE_INTERNAL_TOKEN = "test-voice-token";

const { buildOutboundCallTwiml, computeVoiceBridgeSig } = await import(
  "../src/api/routes/phone.js"
);

test("outbound realtime TwiML streams locally with custom parameters", () => {
  const twiml = buildOutboundCallTwiml({
    tenantId: "main",
    mode: "realtime",
    message: "Call Sir about 8am & calendars",
    from: "+15550100",
    to: "+15550101",
    internalToken: "test-voice-token",
    domain: "home.example",
  });
  const expectedSig = crypto
    .createHmac("sha256", "test-voice-token")
    .update("main")
    .digest("hex");

  assert.equal(computeVoiceBridgeSig("main", "test-voice-token"), expectedSig);
  assert.match(twiml, /<Stream url="wss:\/\/voice\.home\.example\/voice\/main">/);
  assert.match(twiml, new RegExp(`<Parameter name="sig" value="${expectedSig}"/>`));
  assert.match(twiml, /<Parameter name="initiator" value="alfred"\/>/);
  assert.match(twiml, /<Parameter name="intent" value="Call Sir about 8am &amp; calendars"\/>/);
  assert.doesNotMatch(twiml, /initiate-call|alfred\.black|SAAS_INTERNAL_URL/);
});

test("outbound TTS TwiML speaks inline and does not open a stream", () => {
  const twiml = buildOutboundCallTwiml({
    tenantId: "main",
    mode: "tts",
    message: "Hello <Sir>",
    from: "+15550100",
    to: "+15550101",
    internalToken: "test-voice-token",
    domain: "home.example",
  });

  assert.match(twiml, /<Say>Hello &lt;Sir&gt;<\/Say>/);
  assert.doesNotMatch(twiml, /<Stream|wss:\/\//);
});
