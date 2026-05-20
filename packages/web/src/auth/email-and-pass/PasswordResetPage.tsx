import { ResetPasswordForm } from "wasp/client/auth";
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

export function PasswordResetPage() {
  return (
    <AuthPageLayout title="New password" subtitle="Choose a new password">
      <ResetPasswordForm appearance={appearance} />
      <div className="mt-8 text-center font-body text-[15px]" style={{ color: "var(--marginalia)" }}>
        <p>
          If everything is okay,{" "}
          <WaspRouterLink
            to={routes.LoginRoute.to}
            className="underline-offset-4 hover:underline"
            style={{ color: "var(--brass)" }}
          >
            go to login
          </WaspRouterLink>
        </p>
      </div>
    </AuthPageLayout>
  );
}
