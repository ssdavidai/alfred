---
name: alfred-sure-finance-bootstrap
description: One-shot setup of Sir's Sure finance app for a fresh tenant. Connects Sir's bank-feed (manual, by Sir, in the Sure UI), then auto-creates a working baseline of categories, family merchants, tags, rules, and a budget — so that from the next bank-feed sync onward, every transaction is auto-categorised. Use when Sir says "bootstrap my finances", "set up Sure", or first asks Alfred to look at his money. Runs an LLM-driven iterative clustering pipeline that typically reaches 70–80% rule coverage; Sir closes the rest with a few rounds of manual confirmation.
version: "1.0"
metadata:
  openclaw:
    emoji: "🚀"
---

# Alfred — Sure Finance Bootstrap

This is the **first-time setup** for Sir's personal-finance instance (Sure). It runs once per tenant. After it completes, every future bank-feed sync auto-categorises against the rules you create here.

The bootstrap is mostly automated — the iterative clustering pipeline does the heavy lifting — but there are **two things Sir must do manually first** in the Sure web UI: connect his bank-feed provider and (optionally) his securities provider. You cannot do those for him.

## STEP 0 — Connection check (always ask first)

Before doing anything else, ask Sir:

> Sir, before I bootstrap your finances I need to confirm two things are in place — connections you have to set up yourself in the Sure web UI:
>
> 1. **Bank-feed provider connected?** Sure supports providers like Lunchflow, SimpleFIN, Plaid, and others depending on Sir's region. All of Sir's bank, credit-card, and money-app accounts (Example Bank, Example Bank, etc.) should be visible in Sure with a recent balance and several days of transaction history.
> 2. **Securities provider connected?** *(Optional — only if Sir tracks investments in Sure.)* Twelve Data is the typical recommendation for live price syncing of stocks/ETFs/crypto.
>
> Have you completed the bank-feed setup in the Sure UI? Are all your accounts showing the right balances?

**If Sir says NO**: stop. Walk him through the manual steps:

1. Open Sure (the launcher icon on his alfred.black dashboard).
2. Go to *Settings → Hosting → Synced providers* (or similar).
3. Connect his preferred bank-feed provider (Lunchflow / SimpleFIN / Plaid / etc.) following the provider's login flow for each bank.
4. Wait for the first sync to complete (usually 5–30 min).
5. Verify each expected account is visible with the right balance.
6. Come back to you when done.

**If Sir says YES**: confirm that there's enough transaction history before running the pipeline:

```
self({endpoint: "/api/v1/sure/transactions", method: "GET", query: {per_page: 1}})
// → {pagination: {total_count: <N>}}
```

Below ~200 transactions the clustering pipeline doesn't have enough signal — better to wait for more sync history. Above ~200, proceed.

## STEP 1 — One-shot bootstrap (the easy path)

If Sir is comfortable with Alfred running the whole pipeline unattended:

```
self({endpoint: "/api/v1/sure/_bootstrap", method: "POST"})
```

This is a thin loopback wrapper that runs the canonical 3-step sequence end-to-end:

1. `POST /api/v1/sure/categories/bootstrap` (idempotent — only runs if Sir has no categories yet)
2. `POST /api/v1/sure/_cluster` — harvests every transaction, runs the iterative pipeline (TF-IDF alias merging → behavioural co-occurrence → LLM category inference, looped until coverage plateaus). Auto-discovers Sir's actual category + tag names so the LLM prompt is grounded in Sir's real taxonomy. Default `target_coverage: 0.80`, `max_iterations: 6`, `llm_top_n: 100`.
3. `POST /api/v1/sure/_cluster/apply` — runs the quality filter (default `min_confidence: 0.85`, drop low-confidence transfer-roles), creates FamilyMerchants, creates Rules (transaction_name LIKE %keyword% → set merchant + category + tag), fires `apply_all`.

Total wall-clock: roughly 10–30 minutes depending on transaction volume. Cost: a few dimes to a dollar in LLM tokens. Returns a single combined response:

```json
{
  "ok": true,
  "log": [
    "step 1: bootstrapping default categories",
    "step 2: <N> proposals, raw coverage <X>%",
    "step 3: <M> merchants, <K> rules, apply_all rules_applied=<K>"
  ],
  "cluster": {"coverage_percent": <X>, "proposals_count": <N>, "stats": [...]},
  "apply":   {"merchants_created": <M>, "rules_created": <K>, "apply_all": {...}}
}
```

After it returns, fetch the new state to verify:

```
self({endpoint: "/api/v1/sure/transactions", method: "GET", query: {per_page: 1}})
// confirm pagination.total_count matches what Sir expects
```

Then summarise to Sir using the actual numbers from the response — concrete merchants from his data, the real rules count, the real coverage percentage. Don't invent numbers.

## STEP 2 — Two-step path (when Sir wants to review before applying)

For first-time tenants or unusual transaction patterns, run the two steps explicitly so Sir can edit the proposal list before anything is written:

```
// 1. Generate proposals (no writes)
self({endpoint: "/api/v1/sure/_cluster", method: "POST", body: {
  available_categories: [<the bootstrapped category names>],
  available_tags:        [<the tag names>]
}})
// → returns {proposals: [...], stats: [...], coverage_percent}
```

Walk Sir through the top 30 proposals in conversation. Sample format per proposal:

> "I see N transactions sharing the substring '<keyword>' — proposing to merge them under one canonical merchant called '<canonical>' and tag them all as <Category> with a <Tag> tag. OK?"

Let him approve, edit, or skip. When Sir is happy, apply only the approved subset:

```
self({endpoint: "/api/v1/sure/_cluster/apply", method: "POST", body: {
  proposals: <the array Sir approved>
}})
```

## STEP 3 — Codify Sir's personal classifications (always required)

The pipeline is good at well-known merchants and SaaS but cannot guess at named individuals (cleaner, therapist, contractor, family-member names). After the auto-bootstrap, query the still-uncategorised list and ask Sir directly:

```
self({endpoint: "/api/v1/sure/transactions", method: "GET", query: {
  uncategorized: "true",
  per_page: 100
}})
```

Walk through the recurring person-name outflows (typically the largest residual cluster) and ask:

> Sir, I see recurring outflows to a few individual people — I can't tell who they are without your help. Could you give me a quick rundown so I can write rules?
> - <NAME #1>: <count>× <currency> outflows, <amount>/month average
> - <NAME #2>: <count>× <currency> outflows, <amount>/month average
> - …

For each, confirm what they are (cleaner → Services, therapist → Healthcare, family member → Transfers, contractor → Services with Business Expense tag, salary recipient → Income, etc.) and create one Rule per person following the `alfred-sure-operations` skill's rule-creation pattern (transaction_name OR memo LIKE `%<NAME>%` → set merchant + category + tag).

Don't invent classifications. If Sir doesn't know who someone is, leave them uncategorised and surface them in the next conversation.

## STEP 4 — Set up auto-exclusion of internal flows from reports

Sir typically wants intra-account transfers (Example Bank→Example Bank, top-ups between his own accounts, paying off his own credit-card / mortgage / loan) **not counted** as income or expense in cashflow reports. Create one mega-rule that catches the Transfers category and excludes:

```
self({endpoint:"/api/v1/sure/categories", method:"GET"})
// → resolve "Transfers" → its category_id

self({endpoint: "/api/v1/sure/rules", method: "POST", body: {
  name: "Transfers → Exclude from reports & budgets (intra-account)",
  resource_type: "transaction",
  active: true,
  conditions: [
    {condition_type: "transaction_category", operator: "=", value: "<Transfers category id>"}
  ],
  actions: [
    {action_type: "exclude_transaction", value: "true"}
  ]
}})
```

Then apply it once with `ignore_attribute_locks: true` so all existing transfer-categorised transactions get the `excluded=true` flag set:

```
self({endpoint: "/api/v1/sure/rules/<that-rule-id>/apply", method: "POST", body: {
  ignore_attribute_locks: true
}})
```

From now on every transaction landing in Transfers auto-excludes from reports — Sir's "net savings" number stops counting wallet-to-wallet movements.

## STEP 5 — Bootstrap a budget

```
self({endpoint: "/api/v1/sure/budgets/find_or_bootstrap", method: "POST", body: {start_date: "<this month's first day, YYYY-MM-01>"}})
```

This creates the budget shell + sync_budget_categories from the current category set. Then walk Sir through the per-category amounts using `PATCH /api/v1/sure/budget_categories/<id>` for each — see `alfred-sure-operations` skill for the exact format.

If Sir wants a starting point, derive each per-category target from his recent monthly spending average:

```
self({endpoint: "/api/v1/sure/transactions", method: "GET", query: {
  start_date: "<90 days ago>",
  end_date:   "<today>",
  category_ids: ["<that category id>"],
  per_page: 200
}})
// sum signed amounts, divide by 3 → suggested monthly target
```

Always confirm each target with Sir. Don't auto-set. The 90-day average is a conservative starting baseline, not a target.

## STEP 6 — Offer recurring chores (optional)

Once the bootstrap is complete and Sir is happy with the categorisation, offer to set up a few recurring weekly briefings if appropriate for his style. Examples (these may not exist as installed skills on every tenant — only offer if you can see the skill is present):

- A weekly cash-flow forecast — how much came in / went out, what's expected the next two weeks
- A weekly subscription audit — surface price hikes, duplicates, missed charges, zombie subs
- A property/home weekly digest — trades, deliveries, utility bills, renovation spend

Don't push these on Sir. Mention them as available follow-ups, let him decide.

## Pitfalls

- **Never run `_bootstrap` before Sir has connected his bank-feed**. The pipeline needs at least ~200 transactions to produce useful clusters; running it on an empty Sure produces nothing useful and burns LLM tokens.
- **The LLM step is non-deterministic** at temperature 0.1. Running the same input twice can produce slightly different categories at the margin. For deterministic output (e.g. testing), pass `iterative: false` to skip Pass 3.
- **Don't run `apply_all` with `ignore_attribute_locks: true` after Sir has manually corrected transactions in the Sure UI** — it will overwrite his edits. Use targeted rules with locked attributes from then on.
- **Individual person names cannot be classified by the LLM with confidence** — it tends to default-mark them as Transfers (when they're actually contractor payments) or Income (when they're outflows). Always go through STEP 3 with Sir before declaring the bootstrap done.
- **Crypto on/off-ramps** (BTC/ETH inflows from Coinbase / Kraken / Binance to a fiat account) often look like internal transfers but they're realised gains/losses — write a manual Income or specific Crypto category rule.
- **Budget category amounts** should NOT be auto-set without Sir's confirmation. The 90-day average is a starting point, not a target.

## What success looks like

After this skill runs end-to-end:
- Most historical transactions have a category (the long-tail residual is typically individual-name singletons that need Sir's classification or one-off purchases that don't recur).
- A meaningful fraction (typically 70–80%) is auto-categorised by rules; Sir manually verifies the rest.
- Internal flows (own-name transfers, credit-card paydowns, mortgage payments to connected loan accounts) are excluded from cashflow / budget / spending reports.
- A budget exists for the current month with per-category targets Sir has confirmed.
- Every future bank-feed sync runs the rules automatically — Sir doesn't need to do anything for new transactions to be categorised.

## Verification

Before declaring done, sanity-check:

1. `GET /api/v1/sure/transactions?per_page=1` → `pagination.total_count` matches Sir's expected count
2. Sample 10 random transactions across categories and read their names back to Sir for a quick "looks right" check
3. Confirm `excluded` flag is set on Transfers — query a few via `GET /api/v1/sure/transactions/<id>` and verify
4. Check `GET /api/v1/sure/balance_sheet` returns sensible totals matching what Sir sees in the Sure UI

If any of these are off, walk back through the relevant step rather than declaring success.
