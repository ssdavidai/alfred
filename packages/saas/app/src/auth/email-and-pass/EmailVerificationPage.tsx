import { VerifyEmailForm } from "wasp/client/auth";
import { Link as WaspRouterLink, routes } from "wasp/client/router";
import { AuthPageLayout } from "../AuthPageLayout";

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

export function EmailVerificationPage() {
  return (
    <AuthPageLayout title="Verify email" subtitle="Confirming your email address">
      <VerifyEmailForm appearance={appearance} />
      <div className="mt-6 text-center">
        <p className="font-sans text-sm font-light text-[#8A8680]">
          If everything is okay,{" "}
          <WaspRouterLink
            to={routes.LoginRoute.to}
            className="text-[#8A8680] transition-colors hover:text-gold"
          >
            go to login
          </WaspRouterLink>
        </p>
      </div>
    </AuthPageLayout>
  );
}
