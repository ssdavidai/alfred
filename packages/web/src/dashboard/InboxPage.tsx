import { Navigate } from "react-router-dom";

/**
 * InboxPage now redirects to the Vault browser.
 * Inbox is accessible as the "inbox" folder in the vault tree.
 * This redirect preserves backward compatibility for bookmarks and links.
 */
export default function InboxPage() {
  return <Navigate to="/dashboard/vault" replace />;
}
