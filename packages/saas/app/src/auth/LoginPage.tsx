import { LoginForm } from "wasp/client/auth";
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

export default function Login() {
  return (
    <AuthPageLayout title="Welcome back" subtitle="Sign in to your command center">
      <LoginForm appearance={appearance} />
      <div className="mt-8 space-y-2 text-center font-body text-[15px]" style={{ color: "var(--marginalia)" }}>
        <p>
          Don't have an account?{" "}
          <WaspRouterLink
            to={routes.SignupRoute.to}
            className="underline-offset-4 hover:underline"
            style={{ color: "var(--brass)" }}
          >
            Sign up
          </WaspRouterLink>
        </p>
        <p>
          Forgot your password?{" "}
          <WaspRouterLink
            to={routes.RequestPasswordResetRoute.to}
            className="underline-offset-4 hover:underline"
            style={{ color: "var(--brass)" }}
          >
            Reset it
          </WaspRouterLink>
        </p>
      </div>
    </AuthPageLayout>
  );
}
