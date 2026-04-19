// AgentPhone — SaaS-side spam filter.
//
// Cheap deny-list at the Twilio voice webhook: if the caller's number is in
// the SpamNumber Prisma table, the webhook returns <Reject/> immediately.
// Realtime + OpenAI costs never get spent.
//
// The table is populated by:
//   - manual admin API (POST /api/internal/twilio/spam/add)
//   - automated abandoned-call detection — a later iteration; for now the
//     attempts counter just records signals from SaaS-side hangup events.

import { prisma } from "wasp/server";

export async function isSpamNumber(phoneNumber: string): Promise<boolean> {
  if (!phoneNumber) return false;
  try {
    const hit = await prisma.spamNumber.findUnique({
      where: { phoneNumber },
    });
    return Boolean(hit);
  } catch {
    // Failing open: a transient DB hiccup should not block legitimate calls.
    return false;
  }
}

export async function recordAttempt(
  phoneNumber: string,
  reason?: string,
): Promise<void> {
  if (!phoneNumber) return;
  try {
    await prisma.spamNumber.upsert({
      where: { phoneNumber },
      update: {
        attempts: { increment: 1 },
        lastSeen: new Date(),
        ...(reason ? { reason } : {}),
      },
      create: {
        phoneNumber,
        attempts: 1,
        reason: reason ?? "manual",
      },
    });
  } catch (err) {
    console.error("[spam] recordAttempt failed", err);
  }
}

export async function removeSpamNumber(phoneNumber: string): Promise<void> {
  if (!phoneNumber) return;
  try {
    await prisma.spamNumber.delete({ where: { phoneNumber } });
  } catch {
    // Idempotent: no-op if not present.
  }
}
