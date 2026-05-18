/**
 * PostSignupPage — intermediate landing after Wasp auth completes.
 *
 * Problem: Arctic's Google OAuth provider (shipped with Wasp 0.19) silently
 * drops the `accessType` / `prompt` options that main.wasp's getGoogleAuthConfig
 * returns, so the signup flow never gets Google to issue a refresh_token. When
 * the signup-time access token (1h TTL) expires, the backend's OAuth refresher
 * fails with "no refresh token and access token is expired" and every downstream
 * Gmail-using activity (onboarding fetch_email_metadata, stream sync, etc.)
 * dies.
 *
 * Fix: after signup, check whether the current user's Google credential has a
 * refresh_token. If it doesn't (either brand-new signup, or reconnect edge
 * case), bounce straight through the custom /auth/oauth2/google/start flow
 * in server/oauth2.ts — which uses raw URLSearchParams and correctly sends
 * access_type=offline + prompt=consent. That triggers Google's consent
 * screen and returns a refresh_token on callback.
 *
 * If the credential already has a refresh_token (e.g. the user is signing
 * back in after already completing this dance once), skip straight to the
 * dashboard.
 *
 * See PR #473 / commit history for the Arctic 1.x limitation detail.
 */

import { useEffect } from "react";
import { useAuth } from "wasp/client/auth";
import { useQuery, getGoogleRefreshTokenStatus } from "wasp/client/operations";

const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export default function PostSignupPage() {
  const { data: user, isLoading: userLoading } = useAuth();
  const { data: tokenStatus, isLoading: tokenLoading } = useQuery(
    getGoogleRefreshTokenStatus,
  );

  useEffect(() => {
    if (userLoading || tokenLoading) return;

    if (!user) {
      // Auth state vanished — back to login.
      window.location.replace("/login");
      return;
    }

    // Non-Google signups (email+password) have no credential row at all. Nothing
    // to fix; head straight to the dashboard.
    if (!tokenStatus?.hasCredential) {
      window.location.replace("/desk");
      return;
    }

    if (tokenStatus.hasRefreshToken) {
      window.location.replace("/desk");
      return;
    }

    // Google credential exists but no refresh_token — kick into the explicit
    // reconnect flow. userId is accepted as a query param by server/oauth2.ts
    // handleStart, scopes mirror getGoogleAuthConfig(), redirectAfter brings
    // the user home after Google's consent screen.
    const params = new URLSearchParams({
      userId: user.id,
      scopes: GMAIL_READONLY_SCOPE,
      redirectAfter: "/desk",
    });
    window.location.replace(`/auth/oauth2/google/start?${params.toString()}`);
  }, [user, userLoading, tokenStatus, tokenLoading]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <div className="mb-4 text-lg font-medium">Finishing setup…</div>
        <div className="text-sm text-muted-foreground">
          One moment while we connect Gmail.
        </div>
      </div>
    </div>
  );
}
