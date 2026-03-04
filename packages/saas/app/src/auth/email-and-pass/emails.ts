import {
  type GetPasswordResetEmailContentFn,
  type GetVerificationEmailContentFn,
} from "wasp/server/auth";

function brandedEmailHtml({
  heading,
  bodyText,
  ctaUrl,
  ctaLabel,
}: {
  heading: string;
  bodyText: string;
  ctaUrl: string;
  ctaLabel: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background-color:#0A0A0A;font-family:Georgia,'Times New Roman',serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0A0A0A;padding:40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#111111;border:1px solid rgba(184,151,106,0.2);border-radius:2px;">
          <!-- Header -->
          <tr>
            <td style="padding:32px 40px 0;text-align:center;">
              <span style="font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.35em;text-transform:uppercase;color:#B8976A;">ALFRED BLACK</span>
            </td>
          </tr>
          <!-- Gold divider -->
          <tr>
            <td style="padding:20px 40px;">
              <table role="presentation" width="60" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                <tr><td style="height:1px;background-color:#B8976A;"></td></tr>
              </table>
            </td>
          </tr>
          <!-- Heading -->
          <tr>
            <td style="padding:0 40px;text-align:center;">
              <h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:normal;color:#F5F1EB;">${heading}</h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:16px 40px 0;text-align:center;">
              <p style="margin:0;font-family:'DM Sans',-apple-system,sans-serif;font-size:14px;font-weight:300;line-height:1.6;color:#8A8680;">${bodyText}</p>
            </td>
          </tr>
          <!-- CTA Button -->
          <tr>
            <td style="padding:28px 40px;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                <tr>
                  <td style="border:1px solid rgba(184,151,106,0.3);border-radius:2px;">
                    <a href="${ctaUrl}" target="_blank" style="display:inline-block;padding:12px 32px;font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.3em;text-transform:uppercase;text-decoration:none;color:#F5F1EB;">
                      ${ctaLabel}
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Footer divider -->
          <tr>
            <td style="padding:0 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr><td style="height:1px;background-color:rgba(184,151,106,0.1);"></td></tr>
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px 32px;text-align:center;">
              <p style="margin:0;font-family:'DM Sans',-apple-system,sans-serif;font-size:11px;font-weight:300;color:#5A5650;">Sent by Alfred Black &mdash; your digital operations layer.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export const getVerificationEmailContent: GetVerificationEmailContentFn = ({
  verificationLink,
}) => ({
  subject: "Verify your email — Alfred Black",
  text: `Click the link below to verify your email: ${verificationLink}`,
  html: brandedEmailHtml({
    heading: "Verify your email",
    bodyText: "Click the button below to confirm your email address and activate your account.",
    ctaUrl: verificationLink,
    ctaLabel: "Verify Email",
  }),
});

export const getPasswordResetEmailContent: GetPasswordResetEmailContentFn = ({
  passwordResetLink,
}) => ({
  subject: "Reset your password — Alfred Black",
  text: `Click the link below to reset your password: ${passwordResetLink}`,
  html: brandedEmailHtml({
    heading: "Reset your password",
    bodyText: "Click the button below to choose a new password. This link will expire in 24 hours.",
    ctaUrl: passwordResetLink,
    ctaLabel: "Reset Password",
  }),
});
