// /onboarding — legacy route, now a redirect to the new ritual (#852).
//
// The old multi-step Welcome / About / Style / Connect / Done flow is
// superseded by the sequential /awaken → /reading-the-room → /verify →
// /composing → /first-brief → /household ritual added in #852. This
// component exists only to bounce existing in-flight users to the new
// entry point — the legacy SOUL preset chooser, identity form, and
// Composio connect step have all moved.
//
// We keep the route in main.wasp instead of deleting it because (a) the
// post-signup hook in src/auth/hooks.ts and various user-facing emails
// link to /onboarding, and (b) the redirect lets sessions paused on
// /onboarding mid-flow recover gracefully.

import { Navigate } from "react-router-dom";

export default function OnboardingPage() {
  return <Navigate to="/awaken" replace />;
}
