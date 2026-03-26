import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

/**
 * InboxPage now redirects to the Vault browser.
 * Inbox is accessible as the "inbox" folder in the vault tree.
 * This redirect preserves backward compatibility for bookmarks and links.
 */
export default function InboxPage() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate("/dashboard/vault", { replace: true });
  }, [navigate]);

  return null;
}
