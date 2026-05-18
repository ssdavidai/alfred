import { CheckCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "wasp/client/auth";
import {
  generateCheckoutSession,
  getClosedBetaStatus,
  getCustomerPortalUrl,
  useQuery,
} from "wasp/client/operations";
import { Button } from "../../client/components/ui/button";
import {
  PaymentPlanId,
  prettyPaymentPlanName,
  SubscriptionStatus,
} from "../../payment/plans";

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

export default function Pricing() {
  const sectionRef = useRef<HTMLElement>(null);
  const [isPaymentLoading, setIsPaymentLoading] = useState(false);
  const { data: user } = useAuth();
  const navigate = useNavigate();

  const isUserSubscribed =
    !!user &&
    !!user.subscriptionStatus &&
    user.subscriptionStatus !== SubscriptionStatus.Deleted;

  const {
    data: customerPortalUrl,
    isLoading: isCustomerPortalUrlLoading,
  } = useQuery(getCustomerPortalUrl, { enabled: isUserSubscribed });

  const { data: isClosedBeta, isLoading: isClosedBetaLoading } =
    useQuery(getClosedBetaStatus);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.querySelectorAll(".reveal").forEach((el, i) => {
              setTimeout(() => el.classList.add("visible"), i * 200);
            });
          }
        });
      },
      { threshold: 0.1 },
    );
    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

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
      }
    } catch (error: any) {
      console.error(error);
      if (error?.statusCode === 403) {
        navigate("/waitlist");
        return;
      }
      setIsPaymentLoading(false);
    }
  }

  const handleCustomerPortalClick = () => {
    if (!user) {
      navigate("/login");
      return;
    }
    if (customerPortalUrl) {
      window.open(customerPortalUrl, "_blank");
    }
  };

  return (
    <section
      ref={sectionRef}
      id="pricing"
      className="bg-[#0A0A0A] px-6 py-32 lg:py-40"
    >
      <div className="mx-auto max-w-5xl">
        <div className="text-center">
          <p className="reveal font-mono text-sm font-light uppercase tracking-[0.45em] text-gold">
            PRICING
          </p>
          <h2 className="reveal mt-8 font-serif text-4xl font-light leading-[1.3] text-cream md:text-5xl">
            Hire your butler
          </h2>
        </div>

        <div className="reveal mt-20 grid grid-cols-1 gap-8 lg:grid-cols-2 lg:mx-auto lg:max-w-4xl">
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
                  <h3 className="font-serif text-3xl font-light text-cream">
                    {card.name}
                  </h3>
                  <p className="mt-3 font-sans text-base font-light leading-relaxed text-[#8A8680]">
                    {card.description}
                  </p>
                  <div className="mt-6 flex items-baseline gap-1">
                    <span className="font-serif text-5xl font-light text-cream">
                      {card.price}
                    </span>
                    {card.isCheckout && (
                      <span className="font-sans text-base font-light text-[#8A8680]">
                        /month
                      </span>
                    )}
                  </div>
                  <ul className="mt-8 space-y-3">
                    {card.features.map((feature) => (
                      <li
                        key={feature}
                        className="flex items-start gap-3 font-sans text-base font-light text-[#8A8680]"
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
    </section>
  );
}
