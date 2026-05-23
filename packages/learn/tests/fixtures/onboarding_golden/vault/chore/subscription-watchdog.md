---
type: chore
name: Subscription watchdog
status: active
template: subscription_watchdog
schedule: '0 5 * * 5'
schedule_id: chore-subscription-watchdog
params: '{"chore_slug":"subscription-watchdog"}'
user_facing_description: 'Every Friday at 7:00 AM CEST, this chore pulls your last 7 days of financial events across Wise, Mercury, Gránit, Revolut, and Stripe, then diffs them against the prior week''s snapshot. It flags payment failures, price increases above 10%, duplicate services, and zombie subscriptions with no recent usage signals. You only hear about it when deterministic filtering surfaces genuine anomalies and an LLM review confirms they warrant your attention — most Fridays it runs silently.'
generated: true
quarantine: true
quarantine_remaining: 3
workflow_class_name: SubscriptionWatchdogWorkflow
created_by: onboarding_pipeline
created: 2026-05-23T07:40:56.518736+00:00
last_run: null
last_result: null
tags: [auto-generated, chore, financial, generated, quarantine, subscriptions]
---

# Subscription watchdog

Weekly audit of all recurring charges across personal and business accounts (Wise, Mercury, Gránit, Revolut, Stripe). Surfaces failed payments, unexpected price changes, duplicate services, and zombie subscriptions that survived the card migration incomplete. Cross-references active services against actual usage signals in email.

> **Generated chore.** This workflow was written specifically for you during onboarding by Opus. The first 3 runs execute in dry-run mode (no notifications, no vault writes) so we can confirm it behaves as expected before going live.

## What this does

Every Friday at 7:00 AM CEST, this chore pulls your last 7 days of financial events across Wise, Mercury, Gránit, Revolut, and Stripe, then diffs them against the prior week's snapshot. It flags payment failures, price increases above 10%, duplicate services, and zombie subscriptions with no recent usage signals. You only hear about it when deterministic filtering surfaces genuine anomalies and an LLM review confirms they warrant your attention — most Fridays it runs silently.

**Template:** `subscription_watchdog`
**Schedule:** `0 5 * * 5` (cron, UTC)

## Run log
