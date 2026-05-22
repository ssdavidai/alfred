// /claude → /settings#agent (F84). Claude Setup is no longer its own
// top-level page; its sections (MCP servers, approval secret, skills, vault
// login) were folded into Settings → Agent Configuration. This thin redirect
// preserves bookmarks and any in-product links to /claude.
import { Navigate } from "react-router-dom";

export default function ClaudeRedirect() {
  return <Navigate to="/settings#agent" replace />;
}
