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
    <div className="min-h-screen bg-[#0A0A0A] px-6 py-32">
      <div className="mx-auto max-w-5xl">
        <div className="text-center">
          <p className="font-mono text-[0.62rem] font-light uppercase tracking-[0.45em] text-gold">
            PRICING
          </p>
          <h2 className="mt-8 font-serif text-3xl font-light leading-[1.4] text-cream md:text-4xl">
            Hire your butler
          </h2>
          <p className="mx-auto mt-6 max-w-2xl font-sans text-base font-light leading-relaxed text-[#8A8680]">
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
                className={`flex flex-col justify-between rounded-sm border p-8 transition-all duration-300 ${
                  isPremium
                    ? "border-gold bg-[#0A0A0A]"
                    : "border-gold-dim bg-[#0A0A0A]"
                }`}
              >
                <div>
                  <h3 className="font-serif text-2xl font-light text-cream">
                    {card.name}
                  </h3>
                  <p className="mt-3 font-sans text-sm font-light leading-relaxed text-[#8A8680]">
                    {card.description}
                  </p>
                  <div className="mt-6 flex items-baseline gap-1">
                    <span className="font-serif text-4xl font-light text-cream">
                      {card.price}
                    </span>
                    {card.isCheckout && (
                      <span className="font-sans text-sm font-light text-[#8A8680]">
                        /month
                      </span>
                    )}
                  </div>
                  <ul className="mt-8 space-y-3">
                    {card.features.map((feature) => (
                      <li
                        key={feature}
                        className="flex items-start gap-3 font-sans text-sm font-light text-[#8A8680]"
                      >
                        <CheckCircle className="mt-0.5 h-4 w-4 flex-none text-gold" />
                        {feature}
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
