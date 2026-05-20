import type { GetGoogleRefreshTokenStatus } from "wasp/server/operations";
import { HttpError } from "wasp/server";

/**
 * Query the current user's Google OAuthCredential to see whether it has a
 * usable refresh_token. Used by PostSignupPage to decide whether to bounce
 * through the custom /auth/oauth2/google/start flow — see that page for
 * the underlying Wasp/Arctic limitation context.
 */
export const getGoogleRefreshTokenStatus: GetGoogleRefreshTokenStatus<
  void,
  { hasCredential: boolean; hasRefreshToken: boolean }
> = async (_args, context) => {
  if (!context.user) {
    throw new HttpError(401, "Unauthorized");
  }

  const cred = await context.entities.OAuthCredential.findUnique({
    where: {
      userId_provider: { userId: context.user.id, provider: "google" },
    },
    select: { refreshToken: true },
  });

  if (!cred) {
    return { hasCredential: false, hasRefreshToken: false };
  }

  return {
    hasCredential: true,
    hasRefreshToken: Boolean(cred.refreshToken && cred.refreshToken.length > 0),
  };
};
