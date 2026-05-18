import { Subscription } from "@polar-sh/sdk/models/components/subscription.js";
import { SubscriptionStatus } from "@polar-sh/sdk/models/components/subscriptionstatus.js";
import { WebhookOrderPaidPayload } from "@polar-sh/sdk/models/components/webhookorderpaidpayload.js";
import { WebhookSubscriptionUpdatedPayload } from "@polar-sh/sdk/models/components/webhooksubscriptionupdatedpayload.js";
import { validateEvent } from "@polar-sh/sdk/webhooks";
import express from "express";
import type { MiddlewareConfigFn, PrismaClient } from "wasp/server";
import type { PaymentsWebhook } from "wasp/server/api";
import { provisionInstance } from "wasp/server/jobs";
import { requireNodeEnvVar } from "../../server/utils";
import { assertUnreachable } from "../../shared/utils";
import { UnhandledWebhookEventError } from "../errors";
import {
  getPaymentPlanIdByPaymentProcessorPlanId,
  SubscriptionStatus as OpenSaasSubscriptionStatus,
  PaymentPlanId,
  tierToServerType,
} from "../plans";
import { updateUserSubscription } from "../user";

export const polarMiddlewareConfigFn: MiddlewareConfigFn = (
  middlewareConfig,
) => {
  middlewareConfig.delete("express.json");
  middlewareConfig.set(
    "express.raw",
    express.raw({ type: "application/json" }),
  );

  return middlewareConfig;
};

export const polarWebhook: PaymentsWebhook = async (
  request,
  response,
  context,
) => {
  const prismaUserDelegate = context.entities.User;
  try {
    const event = validateEvent(
      request.body,
      request.headers as Record<string, string>,
      requireNodeEnvVar("POLAR_WEBHOOK_SECRET"),
    );

    switch (event.type) {
      case "order.paid":
        await handleOrderPaid(event, prismaUserDelegate, context);
        break;
      case "subscription.updated":
        await handleSubscriptionUpdated(event, prismaUserDelegate);
        break;
      default:
        throw new UnhandledWebhookEventError(event.type);
    }
    return response.status(204).send();
  } catch (error) {
    if (error instanceof UnhandledWebhookEventError) {
      if (process.env.NODE_ENV === "development") {
        console.info("Unhandled Polar webhook event in development: ", error);
      } else if (process.env.NODE_ENV === "production") {
        console.error("Unhandled Polar webhook event in production: ", error);
      }
      return response.status(200).json({ error: error.message });
    }

    console.error("Polar webhook error: ", error);
    if (error instanceof Error) {
      return response.status(400).json({ error: error.message });
    } else {
      return response
        .status(500)
        .json({ error: "Error processing Polar webhook event" });
    }
  }
};

async function handleOrderPaid(
  { data: order }: WebhookOrderPaidPayload,
  userDelegate: PrismaClient["user"],
  context: any,
): Promise<void> {
  const paymentPlanId = getPaymentPlanIdByPaymentProcessorPlanId(
    order.productId,
  );

  // Update subscription status
  await updateUserSubscription(
    {
      paymentProcessorUserId: order.customerId,
      paymentPlanId,
      subscriptionStatus: OpenSaasSubscriptionStatus.Active,
      datePaid: order.createdAt,
    },
    userDelegate,
  );

  // Find the user by their payment processor ID
  const user = await userDelegate.findUnique({
    where: { paymentProcessorUserId: order.customerId },
  });

  if (!user) {
    console.error(`No user found for Polar customer ${order.customerId}`);
    return;
  }

  // Check if user already has an instance
  const existingInstance = await context.entities.Instance.findUnique({
    where: { userId: user.id },
  });

  if (existingInstance && !["destroyed", "error"].includes(existingInstance.status)) {
    console.info(`User ${user.id} already has an active instance (${existingInstance.status}), skipping provisioning`);
    return;
  }

  // Clean up destroyed/errored instance + old jobs so we can re-provision
  if (existingInstance) {
    console.info(`User ${user.id} has a ${existingInstance.status} instance, cleaning up for re-provisioning`);
    await context.entities.ProvisioningJob.deleteMany({
      where: { userId: user.id },
    });
    await context.entities.Instance.delete({
      where: { id: existingInstance.id },
    });
  }

  // Generate a unique customer name
  const slug = (user.email || user.id).split("@")[0].replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 20);
  const customerName = `alfred-${slug}-${Date.now().toString(36)}`;
  const serverType = tierToServerType[paymentPlanId];

  // Create Instance record
  const instance = await context.entities.Instance.create({
    data: {
      userId: user.id,
      customerName,
      tier: paymentPlanId.toUpperCase(),
      serverType,
      status: "provisioning",
    },
  });

  // Create ProvisioningJob record
  await context.entities.ProvisioningJob.create({
    data: {
      userId: user.id,
      instanceId: instance.id,
      status: "pending",
    },
  });

  console.info(`Created provisioning job for user ${user.id}, instance ${instance.id}`);

  // Immediately enqueue the provisioning job
  await provisionInstance.submit({});
  console.info(`Enqueued provisionInstance job for instance ${instance.id}`);
}

async function handleSubscriptionUpdated(
  { data: subscription }: WebhookSubscriptionUpdatedPayload,
  userDelegate: PrismaClient["user"],
): Promise<void> {
  const newSubscriptionStatus = getOpenSaasSubscriptionStatus(subscription);
  if (!newSubscriptionStatus) {
    return;
  }

  const paymentPlanId = getPaymentPlanIdByPaymentProcessorPlanId(
    subscription.productId,
  );

  await updateUserSubscription(
    {
      paymentProcessorUserId: subscription.customer.id,
      subscriptionStatus: newSubscriptionStatus,
      paymentPlanId,
    },
    userDelegate,
  );
}

function getOpenSaasSubscriptionStatus(
  subscription: Subscription,
): OpenSaasSubscriptionStatus | undefined {
  const polarToOpenSaasSubscriptionStatus: Record<
    SubscriptionStatus,
    OpenSaasSubscriptionStatus | undefined
  > = {
    trialing: OpenSaasSubscriptionStatus.Active,
    active: OpenSaasSubscriptionStatus.Active,
    past_due: OpenSaasSubscriptionStatus.PastDue,
    canceled: OpenSaasSubscriptionStatus.Deleted,
    unpaid: OpenSaasSubscriptionStatus.Deleted,
    incomplete_expired: OpenSaasSubscriptionStatus.Deleted,
    incomplete: undefined,
  };

  const subscriptionStatus =
    polarToOpenSaasSubscriptionStatus[subscription.status];

  if (
    subscriptionStatus === OpenSaasSubscriptionStatus.Active &&
    subscription.cancelAtPeriodEnd
  ) {
    return OpenSaasSubscriptionStatus.CancelAtPeriodEnd;
  }

  return subscriptionStatus;
}
