import { ForgotPasswordForm } from "wasp/client/auth";
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

export function RequestPasswordResetPage() {
  return (
    <AuthPageLayout title="Reset password" subtitle="We'll send you a reset link">
      <ForgotPasswordForm appearance={appearance} />
    </AuthPageLayout>
  );
}
