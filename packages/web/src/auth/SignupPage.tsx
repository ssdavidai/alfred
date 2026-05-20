import { SignupForm } from "wasp/client/auth";
import { Link as WaspRouterLink, routes } from "wasp/client/router";
import { AuthPageLayout } from "./AuthPageLayout";

const appearance = {
  colors: {
    brand: '#B8976A',
    brandAccent: '#9F8159',
    submitButtonText: '#F5F1EB',
    errorBackground: 'rgba(220, 38, 38, 0.1)',
    errorText: '#fa3838',
    successBackground: 'rgba(107, 168, 184, 0.1)',
    successText: '#6BA8B8',
    formErrorText: '#fa3838',
  },
};

export function Signup() {
  return (
    <AuthPageLayout title="Begin your story" subtitle="Create an account to get started">
      <SignupForm appearance={appearance} />
      <div className="mt-8 text-center font-body text-[15px]" style={{ color: "var(--marginalia)" }}>
        <p>
          Already have an account?{" "}
          <WaspRouterLink
            to={routes.LoginRoute.to}
            className="underline-offset-4 hover:underline"
            style={{ color: "var(--brass)" }}
          >
            Log in
          </WaspRouterLink>
        </p>
      </div>
    </AuthPageLayout>
  );
}
