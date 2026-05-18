import { defineUserSignupFields } from "wasp/auth/providers/types";
import { prisma } from "wasp/server";
import { z } from "zod";

const adminEmails = process.env.ADMIN_EMAILS?.split(",") || [];

// Single-VM: the very first account created on a fresh install is the owner.
// `isOwner` + `isAdmin` are both set so the owner has full control. Every
// subsequent signup is a plain member. The User.count() runs inside the
// signup transaction, so concurrent first-signups still resolve to one owner.
async function isFirstSignup(): Promise<boolean> {
  const count = await prisma.user.count();
  return count === 0;
}

const emailDataSchema = z.object({
  email: z.string(),
});

export const getEmailUserFields = defineUserSignupFields({
  email: (data) => {
    const emailData = emailDataSchema.parse(data);
    return emailData.email;
  },
  username: (data) => {
    const emailData = emailDataSchema.parse(data);
    return emailData.email;
  },
  isOwner: async () => {
    return isFirstSignup();
  },
  isAdmin: async (data) => {
    const emailData = emailDataSchema.parse(data);
    if (await isFirstSignup()) return true;
    return adminEmails.includes(emailData.email);
  },
});

const githubDataSchema = z.object({
  profile: z.object({
    emails: z
      .array(
        z.object({
          email: z.string(),
          verified: z.boolean(),
        }),
      )
      .min(
        1,
        "You need to have an email address associated with your GitHub account to sign up.",
      ),
    login: z.string(),
  }),
});

export const getGitHubUserFields = defineUserSignupFields({
  email: (data) => {
    const githubData = githubDataSchema.parse(data);
    return getGithubEmailInfo(githubData).email;
  },
  username: (data) => {
    const githubData = githubDataSchema.parse(data);
    return githubData.profile.login;
  },
  isAdmin: (data) => {
    const githubData = githubDataSchema.parse(data);
    const emailInfo = getGithubEmailInfo(githubData);
    if (!emailInfo.verified) {
      return false;
    }
    return adminEmails.includes(emailInfo.email);
  },
});

// We are using the first email from the list of emails returned by GitHub.
// If you want to use a different email, you can modify this function.
function getGithubEmailInfo(githubData: z.infer<typeof githubDataSchema>) {
  return githubData.profile.emails[0];
}

// NOTE: if we don't want to access users' emails, we can use scope ["user:read"]
// instead of ["user"] and access args.profile.username instead
export function getGitHubAuthConfig() {
  return {
    scopes: ["user"],
  };
}

const googleDataSchema = z.object({
  profile: z.object({
    email: z.string(),
    email_verified: z.boolean(),
  }),
});

export const getGoogleUserFields = defineUserSignupFields({
  email: (data) => {
    const googleData = googleDataSchema.parse(data);
    return googleData.profile.email;
  },
  username: (data) => {
    const googleData = googleDataSchema.parse(data);
    return googleData.profile.email;
  },
  isOwner: async () => {
    return isFirstSignup();
  },
  isAdmin: async (data) => {
    const googleData = googleDataSchema.parse(data);
    if (await isFirstSignup()) return true;
    if (!googleData.profile.email_verified) {
      return false;
    }
    return adminEmails.includes(googleData.profile.email);
  },
});

export function getGoogleAuthConfig() {
  return {
    scopes: [
      "profile",
      "email",
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
    accessType: "offline",
    prompt: "consent",
  };
}

const discordDataSchema = z.object({
  profile: z.object({
    username: z.string(),
    email: z.string().email().nullable(),
    verified: z.boolean().nullable(),
  }),
});

export const getDiscordUserFields = defineUserSignupFields({
  email: (data) => {
    const discordData = discordDataSchema.parse(data);
    // Users need to have an email for payment processing.
    if (!discordData.profile.email) {
      throw new Error(
        "You need to have an email address associated with your Discord account to sign up.",
      );
    }
    return discordData.profile.email;
  },
  username: (data) => {
    const discordData = discordDataSchema.parse(data);
    return discordData.profile.username;
  },
  isAdmin: (data) => {
    const discordData = discordDataSchema.parse(data);
    if (!discordData.profile.email || !discordData.profile.verified) {
      return false;
    }
    return adminEmails.includes(discordData.profile.email);
  },
});

export function getDiscordAuthConfig() {
  return {
    scopes: ["identify", "email"],
  };
}
