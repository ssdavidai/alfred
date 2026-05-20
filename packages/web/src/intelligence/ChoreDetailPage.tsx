/**
 * ChoreDetailPage — redirect shell.
 *
 * The canonical chore detail page is /chores/:slug, served by
 * ChoreDetailPage2. This file remains only because main.wasp's
 * ChoreDetailRoute (path /dashboard/chores/:slug) still references it
 * to preserve legacy bookmarks. The full legacy implementation (run
 * log parsing, anti-hallucination audit, etc.) was ported into
 * ChoreDetailPage2 in Phase 1 of the chores rebuild and deleted here.
 */
import { useParams, Navigate } from "react-router-dom";

export default function ChoreDetailPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug ?? "";
  return (
    <Navigate
      to={slug ? `/chores/${encodeURIComponent(slug)}` : "/chores"}
      replace
    />
  );
}
