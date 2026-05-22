import { Navigate } from "react-router-dom";

// /account is folded into /settings#account in Alfred Black 1.0 (F83 — the
// back office was renamed from /study to /settings).
// Kept as a redirect so existing links / Wasp's auth.account.* references
// still resolve.
export default function AccountPage() {
  return <Navigate to="/settings#account" replace />;
}
