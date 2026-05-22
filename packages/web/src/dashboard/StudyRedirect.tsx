// /study → /settings (F83). The unified back office was renamed from
// /study to /settings; this thin redirect preserves bookmarks and any
// /study#<section> deep-links (the hash is carried through by the browser).
import { Navigate, useLocation } from "react-router-dom";

export default function StudyRedirect() {
  const { hash } = useLocation();
  // #settings is the old key for the renamed "Agent Configuration" tab.
  // StudyPage still resolves #settings for back-compat, so pass the hash
  // through verbatim.
  return <Navigate to={`/settings${hash || ""}`} replace />;
}
