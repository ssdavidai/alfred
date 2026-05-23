---
type: chore
name: Money Day
status: active
template: weekly_money_day
schedule: '0 6 * * 2'
schedule_id: chore-money-day
params: '{"preview_only":false,"channel":"last"}'
created_by: onboarding_pipeline
created: 2026-05-23T08:46:42.619617+00:00
last_run: null
last_result: null
tags: [chore, financial, auto-generated]
---

# Money Day

Every Tuesday at 06:00 UTC, asks Alfred to follow the `alfred-sure-operations` skill and produce Sir's Money Day brief: net worth with week-over-week delta, top three outflow categories, anomalies, and the per-account balance table grouped by currency.

**Template:** `weekly_money_day`
**Schedule:** `0 6 * * 2` (cron, UTC)

## Run log
