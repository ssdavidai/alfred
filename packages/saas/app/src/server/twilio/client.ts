// Master Twilio account wrapper. ONLY this module talks to Twilio's REST API.
// Tenants never hold Twilio credentials — every SDK call originates here.
//
// Used by:
//   - twilio/webhooks.ts — incoming voice/SMS routing (uses validateRequest helper)
//   - twilio/internal.ts — outbound SMS/calls + provision/release on behalf of tenants
//   - infra/provisioner.ts (indirectly via the internal HTTP endpoints)

import twilio from "twilio";

let cachedClient: ReturnType<typeof twilio> | null = null;

export function getTwilioClient() {
  if (cachedClient) return cachedClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error(
      "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set for AgentPhone",
    );
  }
  cachedClient = twilio(sid, token);
  return cachedClient;
}

// Validate a webhook signature using twilio-node's helper. Returns true on match.
// `url` is the absolute URL Twilio called (e.g. https://alfred.black/webhooks/twilio/voice).
// `params` is the form-decoded body for POST signature, or {} for GETs.
export function validateTwilioSignature(
  signature: string | undefined,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!signature) return false;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return false;
  return twilio.validateRequest(token, signature, url, params);
}

export interface BuyNumberOpts {
  country: string; // ISO-3166-1 alpha-2, e.g. "HU"
  areaCode?: string;
  voiceUrl: string;
  smsUrl: string;
  friendlyName?: string;
}

// Search for an available number with both SMS + Voice capabilities, then purchase it
// and set both webhooks. Returns {phoneNumber, sid}.
export async function buyNumberWithWebhooks(opts: BuyNumberOpts): Promise<{
  phoneNumber: string;
  sid: string;
}> {
  const client = getTwilioClient();

  // Find an available number that supports SMS + Voice. Local first; mobile if local empty.
  const searchOpts: Record<string, unknown> = {
    smsEnabled: true,
    voiceEnabled: true,
    limit: 1,
  };
  if (opts.areaCode) searchOpts.areaCode = opts.areaCode;

  let available = await client
    .availablePhoneNumbers(opts.country)
    .local.list(searchOpts);

  if (available.length === 0) {
    available = await client
      .availablePhoneNumbers(opts.country)
      .mobile.list(searchOpts);
  }

  if (available.length === 0) {
    throw new Error(`No available SMS+Voice numbers in ${opts.country}`);
  }

  const purchased = await client.incomingPhoneNumbers.create({
    phoneNumber: available[0].phoneNumber,
    voiceUrl: opts.voiceUrl,
    voiceMethod: "POST",
    smsUrl: opts.smsUrl,
    smsMethod: "POST",
    friendlyName: opts.friendlyName,
  });

  return { phoneNumber: purchased.phoneNumber, sid: purchased.sid };
}

export async function setWebhooks(
  numberSid: string,
  voiceUrl: string,
  smsUrl: string,
): Promise<void> {
  const client = getTwilioClient();
  await client.incomingPhoneNumbers(numberSid).update({
    voiceUrl,
    voiceMethod: "POST",
    smsUrl,
    smsMethod: "POST",
  });
}

export async function releaseNumber(numberSid: string): Promise<void> {
  const client = getTwilioClient();
  await client.incomingPhoneNumbers(numberSid).remove();
}

export async function sendSms(opts: {
  from: string;
  to: string;
  body: string;
}): Promise<{ sid: string }> {
  const client = getTwilioClient();
  const msg = await client.messages.create(opts);
  return { sid: msg.sid };
}

export async function createCall(opts: {
  from: string;
  to: string;
  twimlUrl: string; // Twilio fetches this on call connect to get TwiML
}): Promise<{ sid: string }> {
  const client = getTwilioClient();
  const call = await client.calls.create({
    from: opts.from,
    to: opts.to,
    url: opts.twimlUrl,
    method: "POST",
  });
  return { sid: call.sid };
}
