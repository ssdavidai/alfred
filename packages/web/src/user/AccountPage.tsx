import { Navigate } from "react-router-dom";

// /account is folded into /study#account in Alfred Black 1.0.
// Kept as a redirect so existing links / Wasp's auth.account.* references
// still resolve.
export default function AccountPage() {
  return <Navigate to="/study#account" replace />;
}
