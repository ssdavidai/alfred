// /onboarding/orb — legacy route, now a redirect to the new ritual (#852).
//
// See OnboardingPage.tsx for the rationale: the orb-letter sequence is
// replaced by /composing → /first-brief, and the brief is now rendered
// from the live tenant `getFirstBrief` payload instead of the orb
// transition.

import { Navigate } from "react-router-dom";

export default function OnboardingOrbPage() {
  return <Navigate to="/awaken" replace />;
}
