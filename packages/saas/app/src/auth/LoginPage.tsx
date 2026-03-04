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
      <div className="mt-6 space-y-2 text-center">
        <p className="font-sans text-sm font-light text-[#8A8680]">
          Don't have an account?{" "}
          <WaspRouterLink
            to={routes.SignupRoute.to}
            className="text-[#8A8680] transition-colors hover:text-gold"
          >
            Sign up
          </WaspRouterLink>
        </p>
        <p className="font-sans text-sm font-light text-[#8A8680]">
          Forgot your password?{" "}
          <WaspRouterLink
            to={routes.RequestPasswordResetRoute.to}
            className="text-[#8A8680] transition-colors hover:text-gold"
          >
            Reset it
          </WaspRouterLink>
        </p>
      </div>
    </AuthPageLayout>
  );
}
