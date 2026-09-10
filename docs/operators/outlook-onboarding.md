# Operator note — Outlook / Microsoft 365 onboarding (#758)

What an operator needs to know to offer Outlook onboarding on a tenant.

## Prerequisites

1. **Composio is configured.** `COMPOSIO_API_KEY` must be set (the tenant is in
   `composio` onboarding mode). Outlook has no direct-Microsoft-OAuth path; in
   `google` or `none` mode the chooser shows Outlook disabled with a reason.

2. **An Outlook auth config exists on the Composio project** (created once, then
   reused for every tenant on that project). ctrl creates one automatically on
   first connect if none exists, with restricted read-only scopes
   (`offline_access,User.Read,Mail.Read`). If you pre-create it by hand, use the
   same restricted scopes — otherwise Composio's broad managed default
   (`Mail.ReadWrite`, `Mail.Send`, calendars, contacts) is requested at consent.

3. **Microsoft admin consent** may be required on locked-down Microsoft 365
   tenants. The principal (or their IT admin) grants it in the Microsoft consent
   screen; if the org requires admin approval, the connection reports a consent
   error and the chooser surfaces a retryable "administrator must approve"
   message. This is a customer-side step, not a code change.

## What the principal sees

*Start Onboarding* → a chooser (Gmail · Outlook / Microsoft 365) → pick Outlook →
a Microsoft sign-in popup asking for **read-only mail** access → onboarding runs
exactly as Gmail does (reading the room → facts → First Brief).

The consent screen names Composio's Microsoft application. This is expected for
all deployments.

## Verifying

- The Microsoft authorize URL requests exactly `offline_access User.Read
  Mail.Read` (read-only).
- After connect, `onboard.json` carries `email_provider: "outlook"` and the
  chosen `connection_id`, and the tenant Stream row has `source: "outlook"` with
  `composio_action: OUTLOOK_OUTLOOK_LIST_MESSAGES`.
- The First Brief is generated from the Outlook corpus like any Gmail onboarding.

## Notes

- Gmail is unchanged. A tenant can have both a Gmail and an Outlook stream; the
  chooser decides which mailbox onboarding reads.
- Ongoing sync uses append mode (a received-time window), mirroring Gmail.
- No new environment variable is introduced.
