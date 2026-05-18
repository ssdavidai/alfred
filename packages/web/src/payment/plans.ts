import { requireNodeEnvVar } from "../server/utils";

export enum SubscriptionStatus {
  PastDue = "past_due",
  CancelAtPeriodEnd = "cancel_at_period_end",
  Active = "active",
  Deleted = "deleted",
}

export enum PaymentPlanId {
  Premium = "premium",
  Black = "black",
}

export interface PaymentPlan {
  getPaymentProcessorPlanId: () => string;
  effect: PaymentPlanEffect;
}

export type PaymentPlanEffect = { kind: "subscription" };

// Only self-serve plans have payment processor entries.
// Black is custom/contact-us and is not sold through the checkout flow.
export const paymentPlans: Partial<Record<PaymentPlanId, PaymentPlan>> = {
  [PaymentPlanId.Premium]: {
    getPaymentProcessorPlanId: () =>
      requireNodeEnvVar("PAYMENTS_PREMIUM_SUBSCRIPTION_PLAN_ID"),
    effect: { kind: "subscription" },
  },
};

// Maps plan IDs to Acme Cloud server types for new provisioning.
// Grandfathered plans (starter/pro) keep their existing instance serverType
// stored in the Instance table — this mapping is only used for NEW provisions.
export const tierToServerType: Record<string, string> = {
  [PaymentPlanId.Premium]: "cx53",
  [PaymentPlanId.Black]: "cx53",
  // Grandfathered tiers for existing instances
  starter: "cx33",
  pro: "cx43",
};

// Display names for all plans, including grandfathered ones.
const planDisplayNames: Record<string, string> = {
  [PaymentPlanId.Premium]: "Alfred Premium",
  [PaymentPlanId.Black]: "Alfred Black",
  // Grandfathered plan names
  starter: "Starter",
  pro: "Pro",
};

export function prettyPaymentPlanName(planId: string): string {
  return planDisplayNames[planId] ?? planId;
}

// Maps grandfathered plan IDs to their closest current equivalent.
const legacyPlanMapping: Record<string, PaymentPlanId> = {
  starter: PaymentPlanId.Premium,
  pro: PaymentPlanId.Premium,
};

export function parsePaymentPlanId(planId: string): PaymentPlanId {
  if ((Object.values(PaymentPlanId) as string[]).includes(planId)) {
    return planId as PaymentPlanId;
  }
  const mapped = legacyPlanMapping[planId];
  if (mapped) {
    return mapped;
  }
  throw new Error(`Invalid PaymentPlanId: ${planId}`);
}

export function getSubscriptionPaymentPlanIds(): PaymentPlanId[] {
  return Object.values(PaymentPlanId).filter((planId) => {
    const plan = paymentPlans[planId];
    return plan !== undefined && plan.effect.kind === "subscription";
  });
}

export function getPaymentPlanIdByPaymentProcessorPlanId(
  paymentProcessorPlanId: string,
): PaymentPlanId {
  for (const [planId, plan] of Object.entries(paymentPlans)) {
    if (plan.getPaymentProcessorPlanId() === paymentProcessorPlanId) {
      return planId as PaymentPlanId;
    }
  }

  throw new Error(
    `Unknown payment processor plan ID: ${paymentProcessorPlanId}`,
  );
}
