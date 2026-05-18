import { useEffect } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";

const REDIRECT_DELAY_MS = 3000;

export default function CheckoutResultPage() {
  const navigate = useNavigate();
  const [urlSearchParams] = useSearchParams();
  const status = urlSearchParams.get("status");

  useEffect(() => {
    const redirectTimeoutId = setTimeout(() => {
      navigate(status === "success" ? "/setup" : "/pricing");
    }, REDIRECT_DELAY_MS);

    return () => {
      clearTimeout(redirectTimeoutId);
    };
  }, []);

  if (status !== "success" && status !== "canceled") {
    return <Navigate to="/pricing" />;
  }

  return (
    <div className="mt-10 flex flex-col items-stretch sm:mx-6 sm:items-center">
      <div className="flex flex-col gap-4 px-4 py-8 text-center shadow-xl ring-1 ring-gray-100/10 sm:max-w-md sm:rounded-lg sm:px-10">
        <h1 className="text-xl font-semibold">
          {status === "success" && "Payment Successful!"}
          {status === "canceled" && "Payment Canceled."}
        </h1>
        <span>
          {status === "success"
            ? "Redirecting to setup your instance..."
            : "Redirecting back to pricing..."}
        </span>
      </div>
    </div>
  );
}
