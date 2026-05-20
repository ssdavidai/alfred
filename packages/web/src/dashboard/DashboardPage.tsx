// /dashboard → /desk. The canonical home is /desk (Alfred Black 1.0).
//
// The legacy state-machine DashboardPage existed to orchestrate per-tenant
// provisioning + zero-config onboarding while the SaaS fleet stood up a VM.
// Single-VM has no provisioning step, so the legacy implementation is gone;
// /dashboard is a thin back-compat redirect.
import { Navigate } from "react-router-dom";

export default function DashboardPage() {
  return <Navigate to="/desk" replace />;
}
