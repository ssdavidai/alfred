# #758 — Gmail or Outlook / Microsoft 365 at Start Onboarding

Offer Outlook / Microsoft 365 as a **second** onboarding provider alongside
Gmail, without replacing Gmail, without a new store, and without touching the
analysis pipeline. The provider is a second axis (`email_provider`) next to the
existing Gmail transport (`gmail_mode`).

## In one sentence

When the principal clicks *Start Onboarding*, show a two-option chooser; carry
the choice as an explicit `email_provider` from the browser through the web
server, ctrl-api and the Temporal workflow to the collectors, so an Outlook
mailbox flows through the same reading-the-room, facts, patterns,
personalisation, verification, First Brief and packs stages as Gmail does.

## Why it's a wire-to-existing, not a second pipeline

Most of the plumbing is already provider-agnostic:

- **Connection lifecycle** — `initiateConnect(toolkit_slug)` →
  `POST /api/v1/integrations/connect` opens Composio consent for any toolkit.
- **Stream archetype** — a tenant stream row carrying
  `composio_action`/`composio_toolkit`/`composio_args` is pulled by the same
  `StreamPullerWorkflow` branch regardless of toolkit; incremental args come
  from the `SYNC_CONFIGS` table keyed by action slug.
- **Downstream** — the profiler, the Opus fact/pattern/brief stages, the
  curator and the signal scorer read `onboard.json` and the ingest tables, never
  a mailbox. They never learn a provider name.

What was Gmail-bound: the onboarding **start path** (gate → server action →
ctrl route → workflow input) and the **collectors** (query syntax + response
field names). Those are what this feature generalises.

## Verified against the live Composio project (2026-09-10)

The public docs are wrong for this project. The documented `OUTLOOK_LIST_MESSAGES`
slug returns 404. The real read-only tools carry a doubled prefix:

| Purpose | Slug |
|---|---|
| List messages (one folder, skip/top paging) | `OUTLOOK_OUTLOOK_LIST_MESSAGES` |
| Get one message | `OUTLOOK_OUTLOOK_GET_MESSAGE` |
| Profile (identity) | `OUTLOOK_OUTLOOK_GET_PROFILE` |
| List folders | `OUTLOOK_OUTLOOK_LIST_MAIL_FOLDERS` |
| Delta sync (future v2) | `OUTLOOK_GET_MAIL_DELTA` |

`OUTLOOK_OUTLOOK_LIST_MESSAGES` takes one `folder` per call (well-known names
`Inbox` / `SentItems`), typed date filters (`received_date_time_ge` /
`received_date_time_gt`, ISO-8601 **with a `Z` suffix**, not a `+00:00`
offset), `top` (1–1000), `skip` for pagination (**no continuation token**), and
`orderby`. The page arrives at `data.response_data.value[]`.

**Read-only consent works.** Creating a Composio-managed Outlook auth config
with `credentials.scopes = "offline_access,User.Read,Mail.Read"` and initiating
a connection, the Microsoft authorize URL carried exactly those three scopes.
The consent screen names Composio's Microsoft app — accepted for all
deployments.

## The provider × transport matrix

| `email_provider` | `gmail_mode` | metadata activity | backfill activity |
|---|---|---|---|
| gmail | google | `fetch_email_metadata` | `backfill_gmail_as_events` |
| gmail | composio | `composio_fetch_email_metadata` | `composio_backfill_gmail_as_events` |
| outlook | composio | `composio_fetch_email_metadata_outlook` | `composio_backfill_outlook_as_events` |
| outlook | google / none | refused at start (412) — Outlook needs Composio | — |

Never a silent fallback from Outlook to Gmail.

## The layers

**Web** — `DeskOnboardingGate.tsx` opens the chooser (`onboardingProviderCore.ts`
holds the pure logic). Outlook is disabled with a reason when the deployment
isn't in composio mode. `startOnboarding` is provider-aware: it re-verifies an
ACTIVE outlook connection server-side, pins its connection id from the tenant's
own list (never a client flag), writes an `outlook`-source stream, and posts
`email_provider` + `connection_id` to ctrl.

**ctrl** — `/api/v1/workflows/onboarding/start` stamps `email_provider` +
`connection_id` into `OnboardingInput` (rejects an unsupported value);
corrections/brief-resume carries them forward. The connect route creates the
Outlook managed config with restricted read-only scopes
(`MANAGED_AUTH_SCOPES`). The identity route is provider-neutral
(`/identity`, with `/google-identity` as an alias) with an Outlook profile
fallback. `RECOMMENDED_STREAMS` / `SYNC_MODE` / `DEFAULT_ARGS` gain outlook rows.

**learn** — `email_providers.py` is the Outlook edge (arg building, response
extraction, the two normalised message shapes). `pull.py` adds the two Outlook
activities (mirroring the Gmail collectors: 100-day window, 5000-message cap,
per-page retry with quota-aware heartbeated backoff, connection pinning) and the
`SYNC_CONFIGS` append-mode entry. `onboarding_pipeline.py` selects the Outlook
collectors when `email_provider=="outlook"` and persists the provider via a
`workflow.patched`-gated activity (replay safety).

## Replay safety

Adding a `workflow.execute_activity()` call to an existing `@workflow.run` is a
non-additive change (see `packages/learn/CLAUDE.md`). The new
`persist_onboarding_provider` call is gated with
`workflow.patched("758-onboarding-provider")`, so pre-#758 in-flight histories
replay without it. The metadata/backfill selection is safe unguarded: an
in-flight run defaults to gmail and re-selects the identical Gmail activity on
replay; only post-deploy runs can be Outlook.

## Blast radius

Touched: the onboarding start path in three packages; the Composio collector
edge and its parser mapping (additive — no parser change); four source-bucket
normalisers (one branch each); three ctrl lookup tables + one route alias; one
Wasp query; two new `onboard.json` keys.

Untouched by construction: `alfred-state.db`, `ingest.db`, migrations,
`schema.sql`, `server.ts`; the promotion contract and every vault record type;
profiler / facts / patterns / personalisation / verification / brief / packs /
chores; the Hermes image, profiles and MCP servers; compose / Caddy / bootstrap
(no new env var); every existing Gmail test and the legacy direct-Gmail path.

Existing tenants see no change until someone clicks *Start Onboarding* on a
tenant that has never onboarded. Completed and in-flight Gmail onboardings keep
their state — nothing is reset, reconnected or migrated.

## Non-goals

Replacing Gmail; merging multiple mailboxes into one onboarding; resetting
existing tenants; changing the analysis/personality pipeline; Microsoft
calendar / contacts / Teams. Shared-mailbox support is out of scope.

## Follow-ups

- Ongoing Outlook sync uses append mode (mirrors Gmail). A later phase can move
  it to `OUTLOOK_GET_MAIL_DELTA` (`@odata.deltaLink`) under the `sync` pull
  mode once a token is extracted from the link.
- Outlook owner-email mismatch guard at auto-config time (the Gmail-family
  tenant-email guard's Outlook analogue). `startOnboarding` already rejects an
  inactive/mismatched/foreign connection; this would add the wrong-account
  belt-and-suspenders at connect time.
- The downstream LightswitchOS / Nova port is tracked separately; merging Alfred
  source is not evidence a deployed Nova instance has the feature.
