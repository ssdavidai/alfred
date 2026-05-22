import { Navigate } from "react-router-dom";

/**
 * InboxPage now redirects to the canonical Vault surface (/vault).
 * Inbox is accessible as the "inbox" folder in the vault tree.
 * This redirect preserves backward compatibility for bookmarks and links.
 * F46 — was a two-hop via /dashboard/vault; now lands on /vault directly.
 */
export default function InboxPage() {
  return <Navigate to="/vault" replace />;
}
