import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  generateCheckoutSession,
  getClosedBetaStatus,
  getProvisioningStatus,
  getWorkspaceFile,
  reprovisionInstance,
  useQuery,
} from "wasp/client/operations";
import { PaymentPlanId } from "../payment/plans";
import ProvisioningProgress from "./ProvisioningProgress";

const PENDING_PLAN_KEY = "alfred_pending_plan";
const PENDING_PLAN_TTL = 60 * 60 * 1000; // 1 hour

function getAndClearPendingPlan(): PaymentPlanId | null {
  try {
    const raw = localStorage.getItem(PENDING_PLAN_KEY);
    localStorage.removeItem(PENDING_PLAN_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.timestamp > PENDING_PLAN_TTL) return null;

    const validPlanIds = Object.values(PaymentPlanId) as string[];
    if (!validPlanIds.includes(parsed.planId)) return null;

    return parsed.planId as PaymentPlanId;
  } catch {
    localStorage.removeItem(PENDING_PLAN_KEY);
    return null;
  }
}

export default function SetupPage() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery(getProvisioningStatus, undefined, {
    refetchInterval: 3000,
  });
  const { data: isClosedBeta } = useQuery(getClosedBetaStatus);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const checkoutTriggered = useRef(false);
  const reprovisionTriggered = useRef(false);

  // Redirect to waitlist if closed beta is active
  useEffect(() => {
    if (isClosedBeta) {
      navigate("/waitlist");
    }
  }, [isClosedBeta, navigate]);

  // Check workspace files to determine if onboarding is needed
  const isRunning = data?.instance?.status === "running";
  const { data: userMd } = useQuery(
    getWorkspaceFile,
    isRunning ? { filename: "USER.md" } : undefined,
  );
  const { data: soulMd } = useQuery(
    getWorkspaceFile,
    isRunning ? { filename: "SOUL.md" } : undefined,
  );

  // Redirect when instance is running — to onboarding if workspace is empty, otherwise dashboard
  useEffect(() => {
    if (!isRunning) return;
    // Wait for workspace file queries to resolve
    if (userMd === undefined || soulMd === undefined) return;

    const userEmpty = !userMd?.content?.trim();
    const soulEmpty = !soulMd?.content?.trim();
    const destination = userEmpty || soulEmpty ? "/onboarding" : "/dashboard";

    const timer = setTimeout(() => navigate(destination), 2000);
    return () => clearTimeout(timer);
  }, [isRunning, userMd, soulMd, navigate]);

  // Auto-reprovision destroyed or errored instances (user still has active subscription)
  useEffect(() => {
    const status = data?.instance?.status;
    if (!status || (status !== "destroyed" && status !== "error")) return;
    if (reprovisionTriggered.current) return;
    reprovisionTriggered.current = true;

    console.info(`Instance ${status}, triggering re-provisioning...`);
    reprovisionInstance().catch((err: any) => {
      console.error("Re-provisioning failed:", err);
      if (err?.statusCode === 403) {
        navigate("/pricing");
      }
    });
  }, [data?.instance?.status, navigate]);

  // Smart routing: pending plan → checkout, otherwise → pricing
  useEffect(() => {
    if (isLoading || data?.instance || data?.job) return;
    if (checkoutTriggered.current) return;
    checkoutTriggered.current = true;

    const pendingPlanId = getAndClearPendingPlan();
    if (!pendingPlanId) {
      navigate("/pricing");
      return;
    }

    setIsCheckingOut(true);
    generateCheckoutSession(pendingPlanId)
      .then((result) => {
        if (result?.sessionUrl) {
          window.open(result.sessionUrl, "_self");
        } else {
          setCheckoutError("Could not create checkout session. Please try again.");
          setIsCheckingOut(false);
        }
      })
      .catch((error: any) => {
        console.error("Checkout error:", error);
        if (error?.statusCode === 403) {
          navigate("/waitlist");
        } else {
          setCheckoutError("Something went wrong. Please try again.");
          setIsCheckingOut(false);
        }
      });
  }, [isLoading, data, navigate]);

  if (checkoutError) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-md rounded-sm border border-gold-dim bg-[#0A0A0A] p-8 text-center">
          <p className="font-sans text-base font-light text-cream">{checkoutError}</p>
          <Link
            to="/pricing"
            className="mt-6 inline-block font-mono text-sm font-light uppercase tracking-wider text-gold hover:underline"
          >
            Back to Pricing
          </Link>
        </div>
      </div>
    );
  }

  if (isCheckingOut) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <p className="font-sans text-base font-light text-[#8A8680]">
          Preparing checkout...
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <ProvisioningProgress data={data ?? null} isLoading={isLoading} />
    </div>
  );
}
