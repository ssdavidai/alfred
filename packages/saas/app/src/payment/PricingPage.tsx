import { CheckCircle } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "wasp/client/auth";
import {
  generateCheckoutSession,
  getClosedBetaStatus,
  getCustomerPortalUrl,
  useQuery,
} from "wasp/client/operations";
import { Alert, AlertDescription } from "../client/components/ui/alert";
import { Button } from "../client/components/ui/button";
import {
  PaymentPlanId,
  prettyPaymentPlanName,
  SubscriptionStatus,
} from "./plans";

interface PlanCard {
  name: string;
  price: string;
  description: string;
  features: string[];
  cta: string;
  isCheckout: boolean;
}

const planCards: Record<string, PlanCard> = {
  [PaymentPlanId.Premium]: {
    name: prettyPaymentPlanName(PaymentPlanId.Premium),
    price: "$249",
    description:
      "A fully managed butler that handles your life while you sleep",
    features: [
      "Always on — four AI agents working around the clock, even when you forget",
      "Inbox handled — emails, voice memos, and documents processed into structured knowledge",
      "Nothing falls through the cracks — decisions, promises, and commitments are remembered for you",
      "Connections you'd never see — hidden patterns surfaced across your entire life",
      "Wearables and voice devices — ambient capture from the physical world",
      "Scheduled automations — briefings, reminders, and recurring tasks, hands-free",
      "Choose your AI — bring any model, swap anytime",
      "Your data, your infrastructure — encrypted, dedicated, never shared",
    ],
    cta: "HIRE ALFRED",
    isCheckout: true,
  },
  [PaymentPlanId.Black]: {
    name: prettyPaymentPlanName(PaymentPlanId.Black),
    price: "Custom",
    description: "A concierge who knows your name",
    features: [
      "Everything in Premium",
      "A dedicated account manager who understands your life",
      "Custom automations built for you — tell us what you need, we handle the rest",
      "Bespoke integrations — we connect your tools, services, and data sources",
      "Personal onboarding — we set up your world, not just your account",
      "Guaranteed uptime with priority response",
    ],
    cta: "GET IN TOUCH",
    isCheckout: false,
  },
};

const PricingPage = () => {
  const [isPaymentLoading, setIsPaymentLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { data: user } = useAuth();
  const isUserSubscribed =
    !!user &&
    !!user.subscriptionStatus &&
    user.subscriptionStatus !== SubscriptionStatus.Deleted;

  const {
    data: customerPortalUrl,
    isLoading: isCustomerPortalUrlLoading,
    error: customerPortalUrlError,
  } = useQuery(getCustomerPortalUrl, { enabled: isUserSubscribed });

  const { data: isClosedBeta, isLoading: isClosedBetaLoading } =
    useQuery(getClosedBetaStatus);

  const navigate = useNavigate();

  async function handleBuyNowClick(paymentPlanId: PaymentPlanId) {
    if (isClosedBeta) {
      navigate(user ? "/waitlist" : "/login");
      return;
    }
    if (!user) {
      localStorage.setItem(
        "alfred_pending_plan",
        JSON.stringify({ planId: paymentPlanId, timestamp: Date.now() }),
      );
      navigate("/signup");
      return;
    }
    try {
      setIsPaymentLoading(true);
      const checkoutResults = await generateCheckoutSession(paymentPlanId);
      if (checkoutResults?.sessionUrl) {
        window.open(checkoutResults.sessionUrl, "_self");
      } else {
        throw new Error("Error generating checkout session URL");
      }
    } catch (error: any) {
      console.error(error);
      if (error?.statusCode === 403) {
        navigate("/waitlist");
      } else {
        setErrorMessage(
          error?.message || "Error processing payment. Please try again later.",
        );
      }
      setIsPaymentLoading(false);
    }
  }

  const handleCustomerPortalClick = () => {
    if (!user) {
      navigate("/login");
      return;
    }
    if (customerPortalUrlError) {
      setErrorMessage("Error fetching Customer Portal URL");
      return;
    }
    if (!customerPortalUrl) {
      setErrorMessage(`Customer Portal does not exist for user ${user.id}`);
      return;
    }
    window.open(customerPortalUrl, "_blank");
  };

  return (
    <div className="paper min-h-screen px-6 py-32">
      <div className="mx-auto max-w-5xl">
        <div className="text-center">
          <p
            className="font-mono text-[10px] uppercase tracking-[0.32em]"
            style={{ color: "var(--brass)" }}
          >
            Pricing
          </p>
          <h2 className="mt-8 font-display text-4xl md:text-5xl tracking-tight leading-[1.1]">
            Hire your butler
          </h2>
          <p
            className="mx-auto mt-6 max-w-2xl font-body text-[17px] leading-[1.6]"
            style={{ color: "var(--marginalia)" }}
          >
            Alfred is ready in minutes. You don't configure him — he serves you.
          </p>
        </div>

        {errorMessage && (
          <Alert variant="destructive" className="mt-8">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}

        <div className="mt-20 grid grid-cols-1 gap-8 lg:grid-cols-2 lg:mx-auto lg:max-w-4xl">
          {Object.entries(planCards).map(([planId, card]) => {
            const isPremium = planId === PaymentPlanId.Premium;

            return (
              <div
                key={planId}
                className="flex flex-col justify-between border p-8"
                style={{
                  borderColor: isPremium ? "var(--brass)" : "var(--rule)",
                  background: "var(--paper)",
                }}
              >
                <div>
                  <h3 className="font-display text-3xl tracking-tight">
                    {card.name}
                  </h3>
                  <p
                    className="mt-3 font-body text-[15px] leading-[1.55]"
                    style={{ color: "var(--marginalia)" }}
                  >
                    {card.description}
                  </p>
                  <div className="mt-6 flex items-baseline gap-1">
                    <span className="font-display text-5xl tracking-tight">
                      {card.price}
                    </span>
                    {card.isCheckout && (
                      <span
                        className="font-body text-[15px]"
                        style={{ color: "var(--marginalia)" }}
                      >
                        /month
                      </span>
                    )}
                  </div>
                  <hr className="gilt my-8" />
                  <ul className="space-y-3">
                    {card.features.map((feature) => (
                      <li
                        key={feature}
                        className="grid grid-cols-[18px_1fr] gap-3 font-body text-[15px] leading-[1.55]"
                      >
                        <CheckCircle
                          className="mt-1 h-3.5 w-3.5"
                          style={{ color: "var(--brass)" }}
                        />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="mt-10">
                  {!card.isCheckout ? (
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() =>
                        window.open("https://alfred.black", "_blank")
                      }
                    >
                      {card.cta}
                    </Button>
                  ) : isUserSubscribed ? (
                    <Button
                      onClick={handleCustomerPortalClick}
                      disabled={isCustomerPortalUrlLoading}
                      variant="default"
                      className="w-full"
                    >
                      MANAGE SUBSCRIPTION
                    </Button>
                  ) : (
                    <Button
                      onClick={() =>
                        handleBuyNowClick(planId as PaymentPlanId)
                      }
                      variant={isPremium ? "default" : "outline"}
                      className="w-full"
                      disabled={isPaymentLoading || isClosedBetaLoading}
                    >
                      {card.cta}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default PricingPage;
