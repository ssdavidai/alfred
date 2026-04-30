---
name: alfred-sure-operations
description: Read net worth, accounts, transactions, categories, and merchants from Sir's self-hosted Sure personal-finance app, log manual transactions and reconcile illiquid asset valuations, and trigger family-wide bank-feed syncs. Use when Sir asks about money (net worth, spending, balances), when generating Money Day briefs, when logging cash movements, or when setting up Lunchflow as a bank-feed provider.
version: "1.0"
metadata:
  openclaw:
    emoji: "💰"
---

# Alfred — Sure Operations

Sure is Sir's self-hosted personal-finance app — a Rails service running as `sure-web` in the tenant Docker stack. It holds every account, transaction, holding, category, and merchant across Sir's financial life, in whichever currencies he uses.

You reach Sure through the MCP `self` tool by hitting ctrl-api at `/api/v1/sure/<endpoint>`. Ctrl-api proxies to `sure-web:3000/api/v1/<endpoint>` and attaches the `X-Api-Key` header — **never** call `sure-web` directly, the API key is held by ctrl-api. The proxy forwards request method, query string, and body verbatim and returns the response unchanged.

The endpoint paths below match Sure's OpenAPI spec exactly. Note `balance_sheet` uses an underscore — that's deliberate, the spec uses snake_case.

## Endpoints

### 1. Balance sheet — net worth in one call

`self({endpoint: "/api/v1/sure/balance_sheet", method: "GET"})`

Returns `{currency, net_worth, assets, liabilities}` with totals broken down by classification. This is the top-line number for any "what's my net worth?" question and the anchor of every Money Day brief. One call, no pagination, no filters — cheap and idempotent.

Use it when:
- Sir asks "what's my net worth?" or "where do I stand?".
- You're opening a Money Day Tuesday brief and need the headline figure.
- Sir wants a quick sanity-check before a large purchase or transfer.

### 2. List accounts

`self({endpoint: "/api/v1/sure/accounts", method: "GET", query: {page: 1, per_page: 50}})`

Paginated list of every account — bank, investment, crypto, property, manual. Each carries its current balance, currency, and classification. Use this when Sir asks "what accounts do I have?", "what's the balance on my Wise EUR?", or when you need to resolve an account name to its `account_id` before posting a transaction.

Pitfall: the response is paginated. If Sir has more than 50 accounts (rare but possible across HUF/EUR/USD/GBP), walk pages until exhausted before claiming a complete list.

### 3. List transactions (with filters)

`self({endpoint: "/api/v1/sure/transactions", method: "GET", query: {start_date: "2026-04-01", end_date: "2026-04-29", category_ids: ["<groceries-id>"], per_page: 100}})`

This is the workhorse read endpoint. Useful query params (all optional):
- `start_date`, `end_date` — ISO dates (`YYYY-MM-DD`). Filter by transaction date.
- `account_id` or `account_ids[]` — single or multiple account scoping.
- `category_id` or `category_ids[]` — filter by spending category.
- `merchant_id` or `merchant_ids[]` — filter by merchant.
- `tag_ids[]` — filter by tag.
- `min_amount`, `max_amount` — amount bounds.
- `type` — restrict to inflows/outflows/transfers.
- `search` — free-text match against name/description/notes.
- `page`, `per_page` — pagination (default 25, max usually 100).

Each transaction returns `{id, date, amount, amount_cents, signed_amount_cents, currency, name, classification, account, category, merchant, tags[], transfer, ...}`. The `signed_amount_cents` is what you want for arithmetic (negative = outflow).

Pitfall: don't fetch every transaction ever for a wide question — narrow with `start_date`/`end_date` first. Sir's transaction count grows fast and a category-spend question rarely needs more than one month of data.

### 4. Create a transaction (manual entry)

`self({endpoint: "/api/v1/sure/transactions", method: "POST", body: {transaction: {account_id: "<id>", date: "2026-04-29", amount: -400, currency: "EUR", name: "Cash withdrawal", category_id: "<cash-id>"}}})`

Use this when Sir hands you a movement that won't show up in any bank feed — cash withdrawals and spends, between-spouse transfers reconciled by hand, a one-off reimbursement, etc.

Body wraps everything under a `transaction` key. Fields:
- `account_id` *(required)* — resolve via `/accounts` first if Sir gave you a human name.
- `date` *(required)* — ISO `YYYY-MM-DD`. Default to today if Sir didn't say.
- `amount` *(required)* — signed; negative for outflows, positive for inflows. Currency-native units (e.g. `-400.00` for €400 spent).
- `currency` — three-letter ISO. Defaults to the account's currency if omitted.
- `name`, `description`, `notes` — human labels.
- `category_id`, `merchant_id`, `tag_ids[]` — optional classification.
- `nature` — `inflow` / `outflow` / `transfer`.

Pitfall: Sure expects the sign on `amount` to match Sir's intent. €400 cash withdrawal from the EUR current account is `amount: -400`, not `400`.

### 5. Update / recategorize a transaction

`self({endpoint: "/api/v1/sure/transactions/{id}", method: "PATCH", body: {transaction: {category_id: "<groceries-id>"}}})`

Use this when Sir wants to recategorize ("that Tesco run was groceries, not entertainment"), correct an amount, attach a tag, or rename a transaction. Same `transaction.{field}` body shape as create — only include the fields you're changing.

Pitfall: don't issue a PATCH without first reading the transaction to confirm it's the one Sir means. Multiple Tesco runs land each week.

### 6. List categories (with budget status)

`self({endpoint: "/api/v1/sure/categories", method: "GET", query: {classification: "expense", roots_only: true}})`

Returns categories with `{id, name, classification, color, icon, parent, subcategories_count}`. Use it to:
- Resolve a category name to its `id` before filtering transactions or creating one.
- Surface Sir's category tree when he asks "what am I tracking?".
- Check whether a category Sir mentioned actually exists ("groceries" might be filed under "Food & Drink → Groceries").

`roots_only: true` collapses subcategories. `parent_id: <id>` walks the children of a node. `classification` filters expense vs. income vs. transfer.

### 7. List merchants

`self({endpoint: "/api/v1/sure/merchants", method: "GET"})`

Returns `{id, name, type}` per merchant. Use this when Sir asks "how much did I spend at Tesco this year?" — resolve "Tesco" to its merchant id, then call `/transactions?merchant_id=<id>&start_date=...`. Cheaper than `search` for repeat merchants.

### 8. Trigger a sync

`self({endpoint: "/api/v1/sure/sync", method: "POST"})`

Queues a full family-wide sync across every connected provider (Lunchflow, Plaid, SimpleFIN, Binance, Coinbase, etc.). Returns `{id, status, syncing_at, completed_at, ...}`. The sync itself runs asynchronously — the response confirms it's queued, not finished.

Use it before generating a Money Day brief so the figures Sir sees are fresh. Once per session is plenty — calling it on every question wastes provider rate-limit and won't make the data any newer than the last upstream pull.

### 9. Manual valuation (illiquid assets)

`self({endpoint: "/api/v1/sure/valuations", method: "POST", body: {valuation: {account_id: "<property-id>", amount: 165000000, date: "2026-04-29", notes: "Q2 2026 mark"}}})`

Use this for assets that don't have a live feed — the Budapest flat, crypto held in a cold wallet outside connected exchanges, a private-company stake. Posting a valuation re-marks the account's balance to that amount on that date; the balance sheet picks it up on the next read.

Pitfall: `amount` is in currency-native units (HUF for a HUF property account, USD for USD-denominated). Ask Sir for the currency if it isn't obvious from the account.

### 10. API usage

`self({endpoint: "/api/v1/sure/usage", method: "GET"})`

Returns the current rate-limit window: `{rate_limit: {tier, limit, current_count, remaining, reset_in_seconds, reset_at}, api_key: {...}}`. Use it when a sequence of calls starts 429-ing, or when Sir asks "are we hitting a Sure rate limit?". Not a substitute for restraint — see "Good behaviour".

## Worked examples

**Sir: "What's my net worth?"**

```
self({endpoint: "/api/v1/sure/balance_sheet", method: "GET"})
// → {currency: "EUR", net_worth: 412350.22, assets: 458100.00, liabilities: 45749.78}
```

Reply in prose with the right currency symbol, not the raw JSON: "Sir, your net worth sits at €412,350 — €458,100 in assets against €45,750 in liabilities. Want the breakdown by account?"

**Money Day Tuesday brief generation**

```
// 1. Refresh the data first
self({endpoint: "/api/v1/sure/sync", method: "POST"})

// 2. Headline figure
self({endpoint: "/api/v1/sure/balance_sheet", method: "GET"})

// 3. Last-7-day cash movement, grouped later by category
self({endpoint: "/api/v1/sure/transactions", method: "GET", query: {start_date: "2026-04-22", end_date: "2026-04-29", per_page: 100}})

// 4. Account balances for the table
self({endpoint: "/api/v1/sure/accounts", method: "GET", query: {per_page: 100}})
```

Compose the brief in prose: net worth WoW delta, top 3 outflow categories, any anomaly (a transaction more than 2σ above its category mean), and the per-account balance table grouped by currency. Don't paste any of the raw responses.

**Sir: "Log €400 cash I just took out."**

```
// 1. Resolve the EUR current account if you don't already know the id
self({endpoint: "/api/v1/sure/accounts", method: "GET"})
// → find the account, e.g. {id: "acc_123", name: "Revolut EUR", currency: "EUR"}

// 2. Find the cash category (or whichever Sir prefers)
self({endpoint: "/api/v1/sure/categories", method: "GET", query: {classification: "expense"}})

// 3. Post the transaction
self({
  endpoint: "/api/v1/sure/transactions",
  method: "POST",
  body: {transaction: {
    account_id: "acc_123",
    date: "2026-04-29",
    amount: -400,
    currency: "EUR",
    name: "Cash withdrawal",
    category_id: "cat_cash",
    nature: "outflow"
  }}
})
```

Confirm back to Sir with all three concrete details: "Logged, Sir — €400 out of Revolut EUR on 29 April, filed under Cash. Anything else?"

**Sir: "How much did I spend on groceries last month?"**

```
// 1. Resolve the groceries category id
self({endpoint: "/api/v1/sure/categories", method: "GET", query: {classification: "expense"}})
// → find {id: "cat_groceries", name: "Groceries"} (or its parent "Food & Drink" if Sir's tree is hierarchical)

// 2. Pull March transactions for that category
self({
  endpoint: "/api/v1/sure/transactions",
  method: "GET",
  query: {start_date: "2026-03-01", end_date: "2026-03-31", category_ids: ["cat_groceries"], per_page: 100}
})
```

Sum `signed_amount_cents` per currency (Sir's groceries split across HUF and EUR — Tesco runs in Budapest are HUF, Wolt in Vienna is EUR). Reply with each currency total and the combined picture if a clean FX rate is available: "Sir, March groceries: Ft 412,300 in Hungary plus €218 in the EU — roughly €1,250 total at current FX. Tesco was the largest single merchant at Ft 187,000 across nine visits."

## Connecting bank feeds via Lunchflow

Sure handles bank feeds through provider plugins — Plaid (US/CA), SimpleFIN, Sophtron, Enable Banking (EU), Binance, Coinbase, CoinStats, and **Lunchflow**. For Sir, who runs across HUF, EUR, GBP, and USD with accounts at Hungarian and pan-European banks, Lunchflow is the recommended option because it consolidates 25,000+ banks across 40+ countries through a single BYOK key (PSD2 in EU/UK, MX/Plaid for US/CA, regional providers elsewhere).

**Setup is BYOK and Alfred has no Lunchflow-specific code** — Sure handles the entire integration:

1. Sir signs up at **lunchflow.app** and starts a paid plan (~£2.50/month at the base yearly tier, with a 7-day trial; yearly plans require a 2-connection minimum, monthly plans start at 4 connections).
2. From the Lunchflow dashboard, Sir generates an API key.
3. Sir opens his Sure UI at `<subdomain>-sure.<domain>` (the per-tenant Sure web URL).
4. In Sure → **Settings → Providers → Lunchflow**, Sir pastes the API key.
5. Sure auto-discovers connected accounts and starts syncing balances + transactions. Holdings sync where the upstream provider supports it.

Once configured, calling `POST /api/v1/sure/sync` fans out to every Lunchflow-connected institution alongside the other providers — you don't speak to Lunchflow directly.

**Banks Sir uses that Lunchflow covers:** CIB Bank (Hungary), Erste Bank (Hungary), Revolut, Wise, Mercury. The 25,000+ catalog also covers most other European retail banks Sir might add later.

When Sir asks "how do I hook up my bank?", walk him through the five steps above. Don't try to paste his API key for him — he must enter it directly into the Sure UI; ctrl-api does not proxy that screen.

## Good behaviour

1. **Sync once per session, before the brief.** Trigger `/sync` at the start of a Money Day or "where do I stand?" turn — never on every question. Upstream providers refresh on their own cadence, and a second sync within minutes of the first won't yield fresher data.
2. **Translate amounts to natural language with the right currency symbol.** The first character of your Sir-facing message is never `{`. €412,350 not `412350.22 EUR`; Ft 187,000 not `HUF 187000`. Group by currency before any cross-currency total.
3. **Group transactions by category and surface anomalies.** When listing more than ~5 transactions, organise by category (or merchant for a single-category cut), and flag the outliers — a transaction more than 2× its category mean, an unfamiliar merchant, a duplicate-looking pair. Don't make Sir do the parsing.
4. **Mind the currency context.** Sir lives across HUF, EUR, GBP, and USD simultaneously. Never assume the account currency from the symbol Sir typed; resolve via `/accounts` first. When totalling across currencies, name the FX assumption ("at today's ~390 HUF/EUR").
5. **Confirm writes with concrete details.** After `POST /transactions` or `POST /valuations`, echo back the amount, the account, the category, and the date. "Logged €400 from Revolut EUR on 29 April under Cash" — not "done" or "transaction created".
6. **Read before you PATCH.** Recategorising or correcting a transaction without first confirming it's the right one leads to silent damage. Pull the transaction (or the day's list) and verify before issuing the PATCH.
7. **Don't paste raw JSON to Sir.** Every endpoint here returns structured data — your job is to translate. If a call errors or returns `{}`, paraphrase in one sentence and offer a next step. Sir never sees `signed_amount_cents` or `account_id`.

## Full API surface (reference)

The ten endpoints above cover the vast majority of Sir's questions. The platform proxies the **complete** Sure REST API (`docs.sure.am/openapi.yaml`) under `/api/v1/sure/<sure-path>` — every operation Sure exposes is reachable through the MCP `self` tool. Use this table when Sir asks for something the curated ten don't cover.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/sure/accounts` | List accounts (paginated). |
| POST | `/api/v1/sure/accounts` | **Platform extension.** Create a manual account (Loan, Depository, Property, etc.). See "Account CRUD" below. |
| PATCH | `/api/v1/sure/accounts/{id}` | **Platform extension.** Update name, balance, classification, accountable_attributes. |
| DELETE | `/api/v1/sure/accounts/{id}` | **Platform extension.** Soft-delete a manual account. 409 if account is linked to a provider. |
| GET | `/api/v1/sure/balance_sheet` | Net worth + assets + liabilities, in family currency. |
| GET | `/api/v1/sure/categories` | List categories (filters: `classification`, `roots_only`, `parent_id`). |
| GET | `/api/v1/sure/categories/{id}` | Retrieve a single category. |
| GET | `/api/v1/sure/chats` | List Sure-internal AI chats. (Distinct from this conversation, which lives in the external-assistant bridge.) |
| POST | `/api/v1/sure/chats` | Start a new Sure-internal chat. |
| GET | `/api/v1/sure/chats/{id}` | Retrieve a chat with its messages. |
| PATCH | `/api/v1/sure/chats/{id}` | Update a chat (title, etc.). |
| DELETE | `/api/v1/sure/chats/{id}` | Delete a chat. |
| POST | `/api/v1/sure/chats/{chat_id}/messages` | Post a message into a Sure-internal chat. |
| POST | `/api/v1/sure/chats/{chat_id}/messages/retry` | Re-run the last assistant turn in a chat. |
| GET | `/api/v1/sure/holdings` | List investment holdings (positions). |
| GET | `/api/v1/sure/holdings/{id}` | Retrieve a single holding. |
| GET | `/api/v1/sure/imports` | List CSV imports. |
| POST | `/api/v1/sure/imports` | Create a CSV import (bulk-insert transactions). |
| GET | `/api/v1/sure/imports/{id}` | Retrieve import status + parsed rows. |
| GET | `/api/v1/sure/merchants` | List merchants. |
| GET | `/api/v1/sure/merchants/{id}` | Retrieve a single merchant. |
| POST | `/api/v1/sure/sync` | Queue a family-wide sync across every connected provider. |
| GET | `/api/v1/sure/tags` | List transaction tags. |
| POST | `/api/v1/sure/tags` | Create a tag. |
| GET | `/api/v1/sure/tags/{id}` | Retrieve a tag. |
| PATCH | `/api/v1/sure/tags/{id}` | Update a tag. |
| DELETE | `/api/v1/sure/tags/{id}` | Delete a tag. |
| GET | `/api/v1/sure/trades` | List investment trades. |
| POST | `/api/v1/sure/trades` | Record a buy/sell trade. |
| GET | `/api/v1/sure/trades/{id}` | Retrieve a trade. |
| PATCH | `/api/v1/sure/trades/{id}` | Update a trade. |
| DELETE | `/api/v1/sure/trades/{id}` | Delete a trade. |
| GET | `/api/v1/sure/transactions` | List transactions (extensive filters — see §3 above). |
| POST | `/api/v1/sure/transactions` | Create a manual transaction. |
| GET | `/api/v1/sure/transactions/{id}` | Retrieve a transaction. |
| PATCH | `/api/v1/sure/transactions/{id}` | Update / recategorize a transaction. |
| DELETE | `/api/v1/sure/transactions/{id}` | Delete a transaction. |
| GET | `/api/v1/sure/rules` | **Platform extension.** List family rules. See "Rules engine" below. |
| GET | `/api/v1/sure/rules/{id}` | **Platform extension.** Show one rule with conditions + actions + affected count. |
| POST | `/api/v1/sure/rules` | **Platform extension.** Create a rule. |
| PATCH | `/api/v1/sure/rules/{id}` | **Platform extension.** Update a rule (conditions/actions replaced wholesale when supplied). |
| DELETE | `/api/v1/sure/rules/{id}` | **Platform extension.** Delete a rule. |
| POST | `/api/v1/sure/rules/preview` | **Platform extension.** Dry-run a rule definition; returns affected count + sample without saving. |
| POST | `/api/v1/sure/rules/{id}/apply` | **Platform extension.** Re-run a rule against historical transactions. |
| POST | `/api/v1/sure/transfers` | **Platform extension.** Create a transfer (paired outflow + inflow) via Transfer::Creator. |
| POST | `/api/v1/sure/transfers/match` | **Platform extension.** Pair two existing transactions as a transfer (find_or_initialize_by). |
| POST | `/api/v1/sure/transfers/{id}/confirm` | **Platform extension.** Confirm a pending transfer. |
| POST | `/api/v1/sure/transfers/{id}/reject` | **Platform extension.** Reject a transfer; creates RejectedTransfer + destroys. |
| DELETE | `/api/v1/sure/transfers/{id}` | **Platform extension.** Destroy a confirmed transfer; both legs flip back to `kind:standard`. |
| POST | `/api/v1/sure/transactions/{id}/split` | **Platform extension.** Split a parent transaction into N children. |
| POST | `/api/v1/sure/transactions/{id}/unsplit` | **Platform extension.** Restore a split parent (destroys children). |
| POST | `/api/v1/sure/transactions/bulk_update` | **Platform extension.** Bulk-update many transactions in one call. |
| POST | `/api/v1/sure/transactions/bulk_delete` | **Platform extension.** Bulk-delete many transactions in one call. |
| GET | `/api/v1/sure/usage` | Current API rate-limit window. |
| POST | `/api/v1/sure/valuations` | Mark a balance for an illiquid account. |
| GET | `/api/v1/sure/valuations/{id}` | Retrieve a valuation. |
| PATCH | `/api/v1/sure/valuations/{id}` | Update a valuation. |
| DELETE | `/api/v1/sure/users/me` | **Nuclear.** Deactivates Sir's API user. Never call this without explicit, in-the-moment confirmation. |
| DELETE | `/api/v1/sure/users/reset` | **Nuclear.** Wipes ALL family data and returns Sure to a fresh state. Never call this without explicit, in-the-moment confirmation. |

### Account CRUD (platform extension)

Sure's *upstream* REST API is read-only for accounts (only `GET /accounts`). The platform fills the gap by routing `POST/PATCH/DELETE /api/v1/sure/accounts(/{id})` through a Rails runner inside `sure-web` that calls Sure's own ActiveRecord models — same code path as the web UI's Settings → Accounts → New, just bypassing the missing REST endpoint. Use these freely; they are full citizens of the platform.

**Create a manual account** — `self({endpoint: "/api/v1/sure/accounts", method: "POST", body: {…}})`

Required body fields:
- `name` *(string)* — display name, e.g. `"Erste Mortgage"`.
- `balance` *(number)* — current balance in currency-native units. For liabilities, this is the **outstanding balance** (positive number — Sure stores liability balances as positives and the classification flag does the sign).
- `currency` *(string)* — three-letter ISO, e.g. `"HUF"`.
- `accountable_type` *(string)* — one of `"Depository"`, `"Investment"`, `"Crypto"`, `"Property"`, `"Vehicle"`, `"Loan"`, `"CreditCard"`, `"OtherAsset"`, `"OtherLiability"`. Determines what kind of account this is.

Optional body fields:
- `classification` — `"asset"` or `"liability"`. Usually inferred from `accountable_type`; pass explicitly only if Sir wants to override (e.g. a CreditCard tracked as a budget tool rather than a liability).
- `subtype` — accountable-type-specific sub-classification (e.g. `"mortgage"` / `"student"` / `"auto"` / `"other"` for Loan; `"checking"` / `"savings"` for Depository).
- `accountable_attributes` *(object)* — extra fields specific to the accountable type. For a Loan: `interest_rate` (number, e.g. `6.29`), `term_months` (integer), `rate_type` (`"fixed"` or `"variable"`).

**Worked example — adding a 30-year HUF mortgage with 58.5M Ft outstanding at 6.29% fixed:**

```
self({
  endpoint: "/api/v1/sure/accounts",
  method: "POST",
  body: {
    name: "Erste Mortgage",
    balance: 58500000,
    currency: "HUF",
    accountable_type: "Loan",
    subtype: "mortgage",
    accountable_attributes: {
      interest_rate: 6.29,
      term_months: 360,
      rate_type: "fixed"
    }
  }
})
```

**Update an account** — `self({endpoint: "/api/v1/sure/accounts/{id}", method: "PATCH", body: {…}})`

Pass any of the create fields. Fields under `accountable_attributes` update the Loan/Depository/etc. record; everything else updates the Account itself. Always read the account first before patching.

**Delete an account** — `self({endpoint: "/api/v1/sure/accounts/{id}", method: "DELETE"})`

Soft-deletes the account (status flips to `pending_deletion`, async hard-delete follows). **Cannot delete linked accounts** (those tied to a Lunchflow / Plaid / etc. provider) — Sir must unlink the provider in the Sure UI first. The endpoint returns 409 if the account is linked.

### Other gaps in the Sure API (still UI-only)

- **No category mutations.** Sure seeds the category tree; categories cannot be created, renamed, or deleted via the API. Sir adjusts them in the Sure UI.
- **No merchant mutations.** Merchants are inferred from transactions; you can read them but not edit. To "rename" a merchant, recategorize the transactions instead.
- **No institution mutations.** Provider links (Lunchflow / Plaid / etc.) are managed exclusively through the Sure web UI's Settings → Providers screen. Sir pastes API keys there.
- **No transfer creation (one-off).** Sure models loan payments and inter-account moves as `Transfer` records (paired outflow + inflow). There is no `transfer` field on `POST/PATCH /transactions` and no `/transfers` endpoint. **For recurring transfers — use the Rules engine via the platform extension at `/api/v1/sure/rules` (see below).** For one-off transfers, the Sure UI's "Mark as transfer" button is still the only path.

For transactions, trades, valuations, tags, chats, and imports — full CRUD is available through the standard REST surface listed in the table above.

## Loan repayments (and other transfers between accounts)

Sure models a debt repayment as a `Transfer`: a paired outflow on the source account (e.g. Wise HUF) and an inflow on the destination account (e.g. JBC Mortgage), linked by a `Transfer` record. Marked-as-transfer transactions are excluded from spending totals and reduce the loan's outstanding balance instead.

**Important — there is no API path to create or confirm transfers.** `POST /api/v1/sure/transactions` and `PATCH /api/v1/sure/transactions/{id}` accept only the standard transaction fields (`account_id`, `date`, `amount`, `name`, `description`, `notes`, `currency`, `category_id`, `merchant_id`, `nature`, `tag_ids`). The platform proxy mirrors that — there is no `transfer` field. Transfer creation goes through the Sure web UI's Transactions screen ("Mark as transfer" button) or the Rules engine (auto-classifier, see below).

For Sir's manual loan accounts (no provider sync on the loan side), Sure's auto-matcher cannot pair the bank outflow with anything on the loan account because nothing exists there to match against. Two paths give the right behaviour:

### Path A — automated rule (recommended for recurring payments)

Sure's Rules engine watches new transactions and applies actions when conditions match. For Sir's mortgage and personal loan, the one-time setup is:

1. Sir opens Sure → **Settings → Rules → New Rule**.
2. Resource type: **Transaction**.
3. Conditions (all must match):
   - `Account = Wise HUF` (or whichever account the payment leaves)
   - `Amount = -370,847 Ft` (exact monthly payment, signed for outflow) — or use a tight range like `-370,000 to -371,000`
   - Optional: `Merchant contains "JBC"` or `Date day-of-month = 5` to disambiguate from other 370k outflows
4. Action: **Mark as transfer to → JBC Mortgage** (Sure picks `loan_payment` as the transfer kind automatically because the destination is a Loan account).
5. Save. The rule runs on every newly-imported transaction matching the conditions.

Repeat for the CIB Előrelépő with its own amount and the CIB account as destination. Once both rules exist, Sir's monthly payments auto-classify as transfers from Wise → loan, the loan's outstanding balance decreases automatically each month, and net worth math stays correct without manual intervention.

When Sir asks you to "set up auto-classification for my loan payments", walk him through these five steps. Don't try to create the rule via API — there is no such endpoint.

### Path B — single payment, manual mark via UI

For a one-off payment that wasn't captured by a rule, Sir opens the transaction in the Sure UI and clicks **Mark as transfer → choose destination loan**. Sure's `Transfer::Creator` service handles the rest: pairs a generated inflow on the loan side, creates the `Transfer` record with status `confirmed`, syncs both accounts. There is no API equivalent — recommend the UI step.

### Update — you CAN now create rules and transfers via API

The platform has Rails-runner-backed surfaces for both Rules and Transfers. Use Transfers for **one-off** loan payments, inter-account moves, or "this transaction is actually a transfer" reclassifications. Use Rules (next section) for **recurring** patterns. Full reference for both below.

## Transfers (platform extension)

A `Transfer` pairs an outflow on one account with an inflow on another. Sure auto-derives the transfer kind from the destination account: liability → `loan_payment` (or `cc_payment` for credit cards), investment → `investment_contribution`, otherwise `funds_movement`. Transfers are excluded from spending totals and reduce loan / credit-card balances on the destination side.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/sure/transfers` | Create a fresh transfer (Transfer::Creator). Generates both legs. |
| POST | `/api/v1/sure/transfers/match` | Pair two **existing** transactions as a transfer. |
| POST | `/api/v1/sure/transfers/{id}/confirm` | Confirm a pending (auto-detected) transfer. |
| POST | `/api/v1/sure/transfers/{id}/reject` | Reject a pending transfer; records a RejectedTransfer so the matcher won't re-suggest it. |
| DELETE | `/api/v1/sure/transfers/{id}` | Destroy a confirmed transfer; both legs flip back to `kind:standard`. |

### Create body shape

```
{
  "source_account_id":      "<wise-huf-account-id>",
  "destination_account_id": "<jbc-mortgage-account-id>",
  "amount":                 "370847",         // string or number, currency-native units
  "date":                   "2026-04-30",     // ISO yyyy-mm-dd
  "exchange_rate":          "395.42"          // optional; required if accounts have different currencies and Sure has no rate for the date
}
```

### Worked example — log Sir's monthly mortgage payment

```
self({
  endpoint: "/api/v1/sure/transfers",
  method: "POST",
  body: {
    source_account_id:      "<wise-huf-id>",
    destination_account_id: "<jbc-mortgage-id>",
    amount:                 "370847",
    date:                   "2026-05-05"
  }
})
// → 201 {transfer: {id, status: "confirmed", kind: "loan_payment", ...}}
```

The mortgage's outstanding balance drops by 370,847 Ft after the next account materializer pass. Confirm back to Sir: "Logged the May mortgage payment, Sir — 370,847 Ft against JBC Mortgage. Outstanding balance now ≈ 57,586,785 Ft." Then call `/api/v1/sure/balance_sheet` to verify.

### When to use match vs create

- **`POST /transfers`** — you are creating *both* sides. Use this for manual one-offs Sir asks for ("log a payment", "mark this as moving money to my brokerage").
- **`POST /transfers/match`** — both transactions *already exist* (e.g. bank feed already imported the outflow on Wise HUF and the inflow on Mercury USD), and you just want to record that they are the same money movement. Body: `{inflow_transaction_id, outflow_transaction_id}`. Sure validates opposite amounts and date proximity.

### Confirm / reject

For pending transfers (Sure's auto-matcher creates these in `pending` status when it sees probable pairs in incoming sync data), Sir asks "is this Wise→Mercury actually the same transfer?" Use `confirm` to accept, `reject` to record a RejectedTransfer (the matcher learns and stops suggesting it). Always preview with `GET /transactions/{id}` on each leg before confirming, so Sir hears: "Wise outflow of 1,200 USD on April 28 ↔ Mercury inflow of 1,200 USD on April 29 — confirm?"

## Transaction splits and bulk edits (platform extension)

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/sure/transactions/{id}/split` | Split a parent transaction into multiple children (e.g. a 25,000 Ft Tesco run was 18,000 Ft groceries + 7,000 Ft cleaning supplies). |
| POST | `/api/v1/sure/transactions/{id}/unsplit` | Restore a split parent — destroys all children. |
| POST | `/api/v1/sure/transactions/bulk_update` | Reclassify many transactions in one call (date, notes, name, category_id, merchant_id, tag_ids). |
| POST | `/api/v1/sure/transactions/bulk_delete` | Delete many transactions in one call. Refuses split children. |

### Split body shape

```
{
  "splits": [
    {"name": "Groceries",        "amount": 18000, "category_id": "<groceries>"},
    {"name": "Cleaning supplies", "amount":  7000, "category_id": "<household>"}
  ]
}
```

Sum of `amount` across splits must equal parent `amount`. Sure enforces this and returns 422 with the validation error if it doesn't. Currency is inherited from the parent.

### Bulk update body shape

```
{
  "transaction_ids": ["t1", "t2", "t3"],
  "attributes": {
    "category_id": "<groceries>",
    "merchant_id": "<tesco>",     // optional
    "tag_ids":    ["<weekly>"],   // optional; presence triggers tag replacement (vs no-op when absent)
    "notes":      "March audit"   // optional
  }
}
```

Permitted attribute keys: `date`, `notes`, `name`, `category_id`, `merchant_id`, `tag_ids`. Anything else is silently ignored. The `update_tags` flag is set automatically when `tag_ids` is present in the body — pass an empty array to **clear** all tags, or omit the key to leave tags untouched.

### Worked example — Sir asks "categorize all my Tesco transactions from last month as Groceries"

```
// 1. find them
self({endpoint: "/api/v1/sure/transactions", method: "GET", query: {start_date: "2026-03-01", end_date: "2026-03-31", merchant_ids: ["<tesco-id>"]}})

// 2. bulk reclassify
self({
  endpoint: "/api/v1/sure/transactions/bulk_update",
  method: "POST",
  body: {
    transaction_ids: ["<id1>", "<id2>", ...],
    attributes: { category_id: "<groceries-id>" }
  }
})
// → 200 {ok: true, updated_count: 23, transaction_ids: [...]}
```

Confirm to Sir: "Recategorised 23 March Tesco transactions as Groceries, Sir."

### Why prefer rules over manual bulk for recurring patterns

`bulk_update` is for *one-off* historical cleanup. For anything that repeats, build a Rule (next section) so future imports auto-classify. The hint: if the bulk_update would target three or more transactions matching the same merchant/amount pattern, propose a Rule instead and ask Sir before running the bulk.

## Rules engine (platform extension)

Sure's Rules engine matches transactions against a set of conditions and applies actions when they match. New transactions are evaluated automatically on the next sync; existing transactions can be re-evaluated with `apply`. The platform exposes the full surface at `/api/v1/sure/rules`.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/sure/rules` | List family rules (newest first). |
| GET | `/api/v1/sure/rules/{id}` | Show one rule with its conditions + actions + affected count. |
| POST | `/api/v1/sure/rules` | Create a rule. |
| PATCH | `/api/v1/sure/rules/{id}` | Update a rule. Conditions/actions are replaced wholesale when supplied. |
| DELETE | `/api/v1/sure/rules/{id}` | Delete a rule (and its conditions/actions). |
| POST | `/api/v1/sure/rules/preview` | Dry-run: build the rule but don't save; return matching transactions + count. **Use this before every create.** |
| POST | `/api/v1/sure/rules/{id}/apply` | Run a rule against existing transactions. Body: `{ignore_attribute_locks: bool}`. |

### Body shape — create / update / preview

```
{
  "name": "JBC Mortgage auto-classifier",
  "resource_type": "transaction",        // only "transaction" supported today
  "effective_date": "2024-01-01",        // optional; only transactions on/after this date evaluated
  "conditions": [                        // ALL must match (AND)
    {"condition_type": "transaction_account", "operator": "=", "value": "<wise-huf-account-id>"},
    {"condition_type": "transaction_amount",  "operator": "=", "value": "370847"},
    {"condition_type": "transaction_name",    "operator": "like", "value": "%JBC%"}
  ],
  "actions": [
    {"action_type": "set_as_transfer_or_payment", "value": "<jbc-mortgage-account-id>"}
  ]
}
```

Compound (OR-of-ANDs) conditions are supported via `condition_type: "compound"` with a `sub_conditions` array — but most Alfred-authored rules will be flat AND. Avoid nesting unless Sir explicitly needs OR.

### Condition types and operators

| condition_type | type | Operators | Value shape |
|---|---|---|---|
| `transaction_name` | text | `like` (SQL LIKE — use `%foo%`), `=`, `is_null` | string |
| `transaction_amount` | number | `>`, `>=`, `<`, `<=`, `=` | string-or-number, **absolute value** (Sure compares `ABS(amount)`) |
| `transaction_type` | select | `=` | `"income"` \| `"expense"` \| `"transfer"` |
| `transaction_merchant` | select | `=`, `is_null` | merchant `id` (UUID) |
| `transaction_category` | select | `=`, `is_null` | category `id` (UUID) |
| `transaction_account` | select | `=`, `is_null` | account `id` (UUID) |
| `transaction_details` | text | `like`, `=`, `is_null` | string |
| `transaction_notes` | text | `like`, `=`, `is_null` | string |

Notes: `transaction_amount` filters on the unsigned magnitude, so a 370,847 outflow matches `value: "370847"`. Combine with `transaction_account` (the source account) to disambiguate from inflows of the same magnitude. For a tight match, use `=`; for a forgiving match (Sir's payment varies by a few hundred Ft due to interest), use a compound `>=` and `<=` pair.

### Action types and value shapes

| action_type | Value | Effect |
|---|---|---|
| `set_as_transfer_or_payment` | account `id` (UUID) | Pairs the transaction with a generated inflow/outflow on the target account, creates a `Transfer` record with `kind: loan_payment` (for liabilities), `kind: cc_payment` (for credit cards), or `kind: funds_movement` (for cash transfers). This is the right action for monthly debt payments. |
| `set_transaction_category` | category `id` (UUID) | Reclassify to a specific category. |
| `set_transaction_tags` | comma-separated tag `id`s | Tag the transaction. |
| `set_transaction_merchant` | merchant `id` (UUID) | Force a merchant. |
| `set_transaction_name` | string | Rename the transaction. |
| `exclude_transaction` | (no value) | Hide from spending/income totals (one-off use, e.g. internal accounting noise). |
| `set_investment_activity_label` | string | Label investment activity (advanced — rarely needed). |
| `auto_categorize` / `auto_detect_merchants` | (no value) | AI-driven; only available if Sure has an OpenAI key configured. Skip on a self-hosted tenant unless Sir set that up. |

### Rules setup playbook (the analyze → propose → create loop)

When Sir says "set up rules to make sense of my finances" or "automate my classifications", run this loop:

**Phase 1 — Read.** Pull the last ~100 days of transactions:
```
self({endpoint: "/api/v1/sure/transactions", method: "GET", query: {start_date: "<today-100d>", per_page: 100}})
```
If pagination, walk all pages until empty. Collect: account, signed amount, date, name, merchant, category.

**Phase 2 — Find patterns.** Look for groups of 3+ transactions sharing all of:
- Same source account
- Same magnitude (within ~1% — interest/fee variance is normal)
- Monthly cadence (date-of-month within ±3 days)
- Same or similar name/merchant
Then check the destination: does the magnitude match a Sure account's expected payment (loan monthly_payment, credit card balance), or does the merchant name suggest a category that's currently uncategorized?

Common pattern types:
1. **Loan / credit-card payments** — recurring outflow → `set_as_transfer_or_payment` with destination = the loan/card account
2. **Recurring subscriptions** — recurring outflow with stable merchant → `set_transaction_category` to "Subscriptions" (or whatever Sir uses)
3. **Salary / income** — recurring inflow on Sir's checking → `set_transaction_category` to "Salary"
4. **Transfers between Sir's own accounts** — outflow on one + inflow of same magnitude on another within 2 days → `set_as_transfer_or_payment` with the inflow account as destination

**Phase 3 — Propose.** Summarise each pattern in prose for Sir, with the proposed rule shape (conditions + actions in plain English) and the affected count from preview:
```
self({endpoint: "/api/v1/sure/rules/preview", method: "POST", body: {<proposed rule>}})
```
The preview returns `affected_resource_count` and a `sample` of up to 20 matching transactions. Show Sir the count + the first 3-5 samples so he can sanity-check.

**Phase 4 — Confirm.** Ask Sir: "Shall I create these N rules? (yes / yes-but-skip-X / no)". Wait for explicit confirmation before any `POST /api/v1/sure/rules`.

**Phase 5 — Create.** For each confirmed rule:
```
self({endpoint: "/api/v1/sure/rules", method: "POST", body: {<rule>}})
```
After creation, immediately apply to historical transactions:
```
self({endpoint: "/api/v1/sure/rules/<new-rule-id>/apply", method: "POST", body: {}})
```

**Phase 6 — Report.** Summarise: rules created, transactions affected, before-and-after liabilities + spending category totals if relevant. End with "I'll keep these rules running on every new sync."

### Good behaviour for the rules workflow

1. **Preview before create — every time.** Don't save a rule that would affect 200 transactions when Sir asked for "the mortgage". Confirm `affected_resource_count` matches your expectation.
2. **One purpose per rule.** A rule that does both "mark as transfer" and "set category to X" should usually be two rules. Easier to delete or refine later.
3. **Tight conditions for transfers, loose for categories.** A loan-payment rule should be narrow (account + amount + name) so it never mis-fires; a "categorize all Tesco transactions as Groceries" rule can be a single merchant condition.
4. **Don't auto-create rules without confirmation.** The analysis is yours; the decision is Sir's. Always show the preview and ask.
5. **Use names Sir will recognise.** "JBC Mortgage auto-classifier" beats "Rule 7". The name shows up in Sure's UI when Sir browses rules.
6. **Don't fight Sir's existing rules.** Before creating, list existing rules (`GET /api/v1/sure/rules`) and skip patterns Sir has already covered.

### Why this matters

Sure is a tool. Sir is the customer. Sir is an operator. **Sir doesn't want to clickity-clackity through the Rules UI.** The whole point of running this finance app inside Alfred is that the user and the operator are different people. You analyse, you propose, you confirm, you execute — Sir reads the summary at the end of the day and sees that the books are clean.

---

## Categories, tags, merchants, and apply-all (platform extensions — PR2)

Sure's REST surface for taxonomy is read-only. These platform extension routes give you write access via `bin/rails runner` scripts staged in the tenant's init image. Same envelope as account/rule mutate (HTTP 200/201/422/404/502).

### Endpoint reference

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/sure/categories/bootstrap` | POST | Seed Sir's family with the canonical default category set if empty |
| `/api/v1/sure/categories` | POST | Create a category (`name`, `color`, `classification: "income"\|"expense"`, `lucide_icon`, `parent_id`) |
| `/api/v1/sure/categories/:id` | PATCH | Update a category — same fields |
| `/api/v1/sure/categories/:id?replacement_id=<id>` | DELETE | Destroy a category and replace it on every transaction with the replacement (drop `replacement_id` to leave them uncategorized) |
| `/api/v1/sure/tags/:id/merge_into/:replacement_id` | POST | Merge a duplicate tag into a canonical one — every transaction's tag is rewritten then the source is destroyed |
| `/api/v1/sure/merchants` | POST | Create a custom family merchant (`name`, `color`, `website_url`) — auto-fills the logo |
| `/api/v1/sure/merchants/:id` | PATCH | Rename, recolor, or rewrite the website_url of a family merchant |
| `/api/v1/sure/merchants/:id` | DELETE | Destroy a family merchant (transactions keep their string label) |
| `/api/v1/sure/merchants/merge` | POST | Merge `source_merchant_ids[]` into `target_merchant_id`. Reassigns transactions then destroys the sources |
| `/api/v1/sure/merchants/enhance` | POST | Enqueue `EnhanceProviderMerchantsJob` to refresh provider-merchant logos/metadata |
| `/api/v1/sure/rules/apply_all` | POST | Run every family rule against historical transactions in one pass. Body: `{ignore_attribute_locks: false}` |

### Worked example — merge four duplicate Tesco merchants

Sir has somehow accumulated `Tesco`, `Tesco Express`, `TESCO`, and `Tesco Stores Ltd` as four separate family-merchant rows because his bank descriptions vary. Pick the canonical one and merge:

```
self({endpoint: "/api/v1/sure/merchants", method: "GET"})
// → finds m1=Tesco, m2=Tesco Express, m3=TESCO, m4=Tesco Stores Ltd
self({endpoint: "/api/v1/sure/merchants/merge", method: "POST", body: {
  target_merchant_id: "m1",
  source_merchant_ids: ["m2", "m3", "m4"]
}})
// → {ok: true, target_merchant_id: "m1", merged_count: 3, merged_source_ids: [...]}
```

Every transaction previously tagged with m2/m3/m4 now points at m1 and the duplicates are gone. Spending-by-merchant queries finally make sense.

### Worked example — merge an extra category

Sir created `Coffee` and later realised it overlaps with `Eating Out`. Replace and destroy:

```
self({endpoint: "/api/v1/sure/categories/<coffee-id>?replacement_id=<eating-out-id>", method: "DELETE"})
// → {ok: true, deleted: "<coffee-id>", replacement_id: "<eating-out-id>", reassigned_transactions: 47}
```

### Worked example — apply every rule after a bulk import

After Sir imports a CSV from his old bank, run all his rules in one pass so the new history gets categorised the way the live feed would:

```
self({endpoint: "/api/v1/sure/rules/apply_all", method: "POST", body: {ignore_attribute_locks: false}})
// → {ok: true, rules_applied: 12, results: [{id, name, affected_resource_count}, ...]}
```

`ignore_attribute_locks: true` overrides any per-transaction locks Sir set when correcting an earlier mis-classification — only use it when Sir explicitly says "yes, replay the rules over my manual edits too".

### Pitfalls

- **Category `replacement_id` is optional but usually required.** Destroying a category with transactions attached and no replacement leaves them uncategorised — almost always wrong. Always offer a replacement unless Sir explicitly wants the orphan.
- **Tag merge is one-way.** `POST /api/v1/sure/tags/<source>/merge_into/<target>` destroys the source. Confirm the target id is correct first via `GET /api/v1/sure/tags`.
- **Provider merchants vs family merchants.** Sure has two merchant flavours: `ProviderMerchant` (auto-detected from bank-feed data, read-only) and `FamilyMerchant` (Sir's manual ones). The mutate endpoints only touch family merchants. `merchants/enhance` refreshes the provider side asynchronously.
- **`apply_all` can take 30+ seconds on a busy family.** It loops every rule synchronously through the same scope-and-update path the manual `Apply` button uses. Acceptable for a 30s-budget tool call but consider running it during a Money Day brief, not in the middle of an interactive chat.

---

## Investments — holdings and valuations (platform extensions — PR3)

Sure exposes investment data via `GET /api/v1/sure/accounts/{id}/holdings` but every write op (delete a holding, set a manual cost basis, fix a wrong security mapping, destroy a snapshot valuation) is web-UI only. These platform extension endpoints close that gap.

### Endpoint reference

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/sure/holdings/:id` | DELETE | Destroy a holding **and every trade entry that produced it** — the model wraps a transaction over `account.entries.where(entryable: trades).destroy_all` then `holding.destroy`, then enqueues an account sync |
| `/api/v1/sure/holdings/:id/set_manual_cost_basis` | POST | Set per-share cost basis manually. Body: `{value: "187.50"}`. Locks the holding so provider syncs can't overwrite it |
| `/api/v1/sure/holdings/:id/unlock_cost_basis` | POST | Clears the manual lock so provider/calculated cost basis can take over again |
| `/api/v1/sure/holdings/:id/remap_security` | POST | Move this holding (and every trade for the same security) to a different security. Body: `{security_id: "..."}` or `{ticker: "VOO", exchange_operating_mic: "XNAS"}`. On collision (existing holding for target security on same date+currency), qty/amount are merged with weighted-average cost basis |
| `/api/v1/sure/holdings/:id/reset_security_to_provider` | POST | Revert a manual remap. Only valid when `provider_security_id` is set; restores the original security and unlocks the holding |
| `/api/v1/sure/valuations/:id` | DELETE | Destroy a valuation snapshot. The `:id` here is the **Entry id**, not a separate valuation id — Sure models valuations as a delegated_type on Entry. Returns 422 if the entry isn't a Valuation |

### Worked example — Sir manually adjusts AAPL cost basis

Sir's brokerage sync didn't carry over the right cost basis after a corporate action and his AAPL position is showing the wrong gain. Set it manually:

```
self({endpoint: "/api/v1/sure/accounts/<broker-id>/holdings", method: "GET"})
// → finds holding h1 for AAPL with cost_basis: "0.0", source: "provider"
self({endpoint: "/api/v1/sure/holdings/h1/set_manual_cost_basis", method: "POST", body: {value: "147.32"}})
// → {ok: true, holding: {id: "h1", cost_basis: "147.32", cost_basis_source: "manual", cost_basis_locked: true}}
```

If Sir later wants the brokerage to take over again:

```
self({endpoint: "/api/v1/sure/holdings/h1/unlock_cost_basis", method: "POST"})
// → cost_basis_locked: false; the next provider sync can refresh
```

### Worked example — fix a wrong security mapping

Sir's broker reported a holding under `CUSTOM:VOO123` (a fabricated synthetic ticker) but the real instrument is Vanguard S&P 500 ETF (`VOO` on XNAS). Remap:

```
self({endpoint: "/api/v1/sure/holdings/h1/remap_security", method: "POST", body: {
  ticker: "VOO",
  exchange_operating_mic: "XNAS"
}})
// → {ok: true, holding: {id: "h1", security_id: "<voo-uuid>"}, remapped_to: {id: "<voo-uuid>", ticker: "VOO"}}
```

If Sir was wrong about the remap and wants to revert to whatever the broker originally said:

```
self({endpoint: "/api/v1/sure/holdings/h1/reset_security_to_provider", method: "POST"})
```

### Worked example — destroy a wrong manual valuation

Sir manually entered a valuation for his property at 200,000,000 HUF but realised it should have been 20,000,000. Destroy and re-create:

```
self({endpoint: "/api/v1/sure/transactions", method: "GET", query: {account_id: "<property-id>", per_page: 50}})
// → among entries, find the Valuation entry id v1
self({endpoint: "/api/v1/sure/valuations/v1", method: "DELETE"})
// → {ok: true, deleted: "v1", account_id: "<property-id>"}
self({endpoint: "/api/v1/sure/accounts/<property-id>/valuations", method: "POST", body: {
  valuation: {date: "2026-04-29", amount: 20000000, currency: "HUF"}
}})
```

### Pitfalls

- **`DELETE /holdings/:id` also destroys every trade entry for that security.** This is by design — Sure's UI shows holdings as derived from trades, so destroying the holding without the trades would leave orphan entries that would re-create the holding on the next sync. Only call this when Sir explicitly wants to wipe the position, not "hide it temporarily".
- **`remap_security` moves trades too.** If Sir had real trades on the *target* security before the remap, those will keep their qty/amount but be co-located with the remapped trades. In rare cases this can produce a holding that doesn't match either history. Confirm before remapping a security with non-trivial trade history.
- **Cost basis is per-share, not total.** `set_manual_cost_basis` takes the per-share value (`value: "187.50"` for one share at 187.50). Sir is likely to ask for total cost basis — clarify before posting.
- **Valuation id is the Entry id.** Sure models valuations as `Entry where entryable_type='Valuation'`. The id you pass to `DELETE /valuations/:id` is the Entry id from the transaction listing, not a separate valuation id.

---

## Recurring patterns and duplicate review (platform extensions — PR4)

Sure auto-detects recurring transactions (rent, utilities, subscriptions, payroll) and surfaces "merge with posted duplicate?" prompts when a pending bank-feed entry matches a posted one. The web UI handles all of this; these endpoints expose the same surface to Alfred.

### Recurring endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/sure/recurring/identify` | POST | Run pattern detection synchronously (`RecurringTransaction.identify_patterns_for!`). Returns the count of patterns identified plus the family's currently-active recurring list |
| `/api/v1/sure/recurring/cleanup_stale` | POST | Mark recurring transactions inactive when their last occurrence is too old (`RecurringTransaction.cleanup_stale_for`) |
| `/api/v1/sure/recurring/:id/activate` | POST | Re-enable a previously-deactivated recurring (`#mark_active!`) |
| `/api/v1/sure/recurring/:id/deactivate` | POST | Hide a recurring without deleting it (`#mark_inactive!`) |

### Duplicate endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/sure/transactions/:id/merge_duplicate` | POST | Sir confirms the pending and posted are the same — destroys the pending entry, keeps the posted one (`Transaction#merge_with_duplicate!`). 422 if no suggestion exists |
| `/api/v1/sure/transactions/:id/dismiss_duplicate` | POST | Sir says they're different transactions — sets `extra.potential_posted_match.dismissed=true` so the suggestion stops appearing (`Transaction#dismiss_duplicate_suggestion!`) |

### Worked example — Money Day pending review

During a Money Day brief, surface every transaction with a duplicate suggestion and let Sir adjudicate:

```
self({endpoint: "/api/v1/sure/transactions", method: "GET", query: {has_duplicate_suggestion: true, per_page: 50}})
// for each, summarise (pending name + amount + date) vs (posted name + amount + date)
// ask Sir per row: "merge or keep separate?"
self({endpoint: "/api/v1/sure/transactions/<id>/merge_duplicate", method: "POST"})
// or
self({endpoint: "/api/v1/sure/transactions/<id>/dismiss_duplicate", method: "POST"})
```

### Worked example — Sir cancelled Netflix, deactivate the pattern

```
self({endpoint: "/api/v1/sure/recurring", method: "GET"})
// find Netflix recurring, id=r-netflix
self({endpoint: "/api/v1/sure/recurring/r-netflix/deactivate", method: "POST"})
// → {ok: true, recurring: {id: "r-netflix", status: "inactive"}}
```

When Sir starts a new subscription, run `POST /recurring/identify` after the second occurrence and it'll be picked up automatically.

---

## Account sharing (platform extension — PR4)

Sure supports per-account sharing within a family — Sir can grant view-only or edit access on a specific account to a spouse or co-trustee without sharing the entire family. Permissions: `read_only` (default), `read_write` (annotate but not edit core fields), `full_control` (everything except destroy account).

### Endpoint reference

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/sure/accounts/:account_id/shares` | POST | Create a share. Body: `{email: "..."}` or `{user_id: "..."}` plus `{permission, include_in_finances}` (defaults: `read_only`, `true`). User must be a member of Sir's family already |
| `/api/v1/sure/shares/:id` | PATCH | Update permission or include_in_finances flag |
| `/api/v1/sure/shares/:id` | DELETE | Revoke the share |

### Worked example — share Wise EUR with spouse, view-only

```
self({endpoint: "/api/v1/sure/accounts/<wise-eur-id>/shares", method: "POST", body: {
  email: "spouse@example.com",
  permission: "read_only",
  include_in_finances: false
}})
// → {ok: true, share: {id: "s1", permission: "read_only", include_in_finances: false}}
```

`include_in_finances: false` means the spouse sees the account in their list but it doesn't roll up into their net worth — useful for "view-only awareness" without polluting the spouse's primary view.

### Pitfalls

- **Target user must already be in Sir's family.** Sure validates this — if Sir wants to share with someone external, he has to invite them via `POST /api/v1/sure/invitations` first (PR5), wait for accept, then share.
- **`merge_duplicate` destroys the pending entry.** No undo. Always confirm with Sir before calling — that's why this is a per-transaction confirmation flow, not a "merge all suggestions" bulk op.
- **`recurring/identify` is synchronous and can take 10-20s on a large family.** Trigger it during quiet windows (Money Day brief), not in the middle of an interactive chat.
- **Sharing is family-scoped, not platform-scoped.** Other tenants' users are invisible to Sir's family — `email` lookup only finds users already in his family.

---

## Family administration — invitations, budgets, exports, prefs (PR5)

The last cluster of platform extensions. Every endpoint here represents a household-management workflow Sir would otherwise have to do by clicking through Sure's web UI.

### Invitations

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/sure/invitations` | POST | Create a family invitation. Body: `{email, role}` (role default `member`, must be one of `admin`/`member`/`guest`). Returns the encrypted token and the relative `accept_url_path` so Alfred can email the invitee a usable URL |
| `/api/v1/sure/invitations/:id` | DELETE | Revoke a pending invitation before it's accepted |

**Accept is intentionally NOT exposed.** Sure's `Invitation#accept_for(user)` requires either a token-bearing browser session or programmatic user resolution that bypasses the auth model. The right loop is: Sir asks Alfred → Alfred creates the invitation → Alfred emails the URL to the invitee → invitee opens the URL in their browser → invitee accepts in the Sure UI. Don't try to short-circuit that.

### Budgets

Sure has per-month budgets keyed by `start_date` (always start-of-month, except for families on a custom-month-start cycle). Each budget has a `BudgetCategory` row per family Category with its own `budgeted_spending` amount.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/sure/budgets/find_or_bootstrap` | POST | Idempotent. Body: `{start_date: "2026-04-01"}`. Creates the Budget shell + sync_budget_categories from the current category set if missing, returns it if it already exists |
| `/api/v1/sure/budgets/:id/copy_from` | POST | Clone budgeted_spending values from a prior month. Body: `{source_budget_id}`. Useful at month-end for "same as last month, ±a few categories" |
| `/api/v1/sure/budget_categories/:id` | PATCH | Set the per-category target amount. Body: `{budgeted_spending: "120000.00"}` — string-decimal, currency from parent budget |

### Exports

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/sure/exports` | POST | Create a `FamilyExport` row + enqueue `FamilyDataExportJob`. Returns the export id with status `pending`. Sir can poll `GET /api/v1/sure/exports/:id` (existing read endpoint) to check when status flips to `completed` and `export_file` becomes downloadable |

### User preferences

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/sure/user/preferences` | PATCH | Update permitted user-level prefs. Body: any subset of `{first_name, last_name, theme, locale, ui_layout, show_sidebar, show_ai_sidebar, ai_enabled, rule_prompts_disabled, default_period, default_account_order, default_account_id}`. Defaults to the family owner if no `user_id` supplied |

**Hosting/provider Setting keys (e.g. `Setting.openai_model`, `Setting.brand_fetch_logo_size`, exchange rate provider config) are NOT exposed.** They're nuclear-adjacent — wrong values can break the whole tenant. If Sir asks to change one, walk him through the Sure admin UI manually.

### Worked example — month-end budget rollover

It's the last day of the month. Sir wants next month's budget pre-populated with this month's amounts so he can tweak the few categories that need different numbers:

```
self({endpoint: "/api/v1/sure/budgets", method: "GET", query: {per_page: 4}})
// → finds april = b-april (current), march = b-march

self({endpoint: "/api/v1/sure/budgets/find_or_bootstrap", method: "POST", body: {start_date: "2026-05-01"}})
// → {ok: true, budget: {id: "b-may", start_date: "2026-05-01", category_count: 12}}

self({endpoint: "/api/v1/sure/budgets/b-may/copy_from", method: "POST", body: {source_budget_id: "b-april"}})
// → b-may now has all of b-april's budgeted_spending values

// Sir says "but bump Groceries by 10% — kids growing"
self({endpoint: "/api/v1/sure/budget_categories/<bc-may-groceries-id>", method: "PATCH", body: {
  budgeted_spending: "275000.00"
}})
```

### Worked example — invite spouse to the family

```
self({endpoint: "/api/v1/sure/invitations", method: "POST", body: {
  email: "spouse@example.com",
  role: "member"
}})
// → {ok: true, invitation: {id: "inv-1", token: "...", accept_url_path: "/invitations/abc123/accept"}}

// Alfred composes a brief email to the spouse:
//   "Sir invited you to his Sure household. Open <https://sir.example.com/invitations/abc123/accept>
//    in your browser to join."
// Sends via email channel skill, NOT via Sure.
```

### Worked example — Sir wants a backup before doing something risky

```
self({endpoint: "/api/v1/sure/exports", method: "POST"})
// → {ok: true, export: {id: "fx1", status: "pending", filename: "sure_export_20260430_180000.zip"}}

// Wait a few minutes, then poll:
self({endpoint: "/api/v1/sure/exports/fx1", method: "GET"})
// when status = "completed", surface the download URL to Sir
```

### Pitfalls

- **`find_or_bootstrap` returns null for out-of-window dates.** The valid window is `[max(2y ago, oldest_entry_date), 2y ahead]`. The script returns 422 in that case so Alfred surfaces a clean error rather than silently returning the wrong month.
- **`copy_from` only copies `budgeted_spending` values, NOT category structure.** If the source budget has fewer categories than the target (Sir created new categories between the months), the new ones stay at 0 and need explicit `update_category_budget` calls.
- **Export jobs run asynchronously.** Don't block-poll — return the export id to Sir and let him ask "is it ready?" in a later turn.
- **`ai_enabled: false` disables Sure's own in-app AI features.** It does NOT disable Alfred's access to the API. Sir might still want it on for his Sure UI, even if he's primarily using Alfred.

---

## Transaction clustering pipeline (alfred-learn)

When Sir's transaction list grows past a few hundred, manually-written rules get expensive to maintain. The `alfred-sure-operations` skill ships with a **clustering pipeline** that does the heavy lifting: it harvests every transaction in Sure, runs TF-IDF alias merging on the bank-feed name strings to collapse variants like `TESCO` / `BUDAORS TESCO 41520` / `Tesco Express` into a single canonical merchant, infers a category from a built-in keyword rulebook, and returns *proposals* — one canonical merchant + one rule per cluster — that you (and Sir) can review before executing.

The pipeline lives in `alfred-learn` (the Temporal worker container) and is invoked by ctrl-api via `docker exec`. Two endpoints:

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/sure/_cluster` | POST | Harvest all transactions and run the pipeline. Returns `{proposals: [...], stats: {...}}`. Body (optional): `{similarity_threshold: 0.4, min_group_size: 2}` |
| `/api/v1/sure/_cluster/apply` | POST | Execute approved proposals. Body: `{proposals: [...]}`. For each: creates a `FamilyMerchant` (skip if exists), creates a `Rule` (`transaction_name LIKE %keyword%` → set merchant + category + tag), then fires `apply_all`. Returns `{merchants_created, rules_created, failures, apply_all}` |

### Worked example — bootstrap categorisation on a fresh tenant

Sir just connected his bank feed and now has 3,000+ transactions sitting in Sure with no categorisation:

```
self({endpoint: "/api/v1/sure/_cluster", method: "POST", body: {}})
// → {
//     proposals: [
//       {canonical_name: "Tesco", pattern_keyword: "tesco",
//        proposed_category: "Groceries", proposed_tag: "Grocery",
//        role: "merchant", txn_count: 45, confidence: 0.95, ...},
//       {canonical_name: "Wolt", ..., proposed_category: "Food & Drink",
//        proposed_tag: "Food Delivery", txn_count: 41, ...},
//       ...
//     ],
//     stats: {input_count: 3267, proposals: 389, matched_txns: 1820, coverage_percent: 55.7}
//   }
```

Walk Sir through the 30-50 highest-volume proposals — show canonical name + suggested category + sample bank descriptions — and ask which to accept. Then:

```
self({endpoint: "/api/v1/sure/_cluster/apply", method: "POST", body: {
  proposals: [<approved subset>]
}})
// → {
//     ok: true,
//     merchants_created: 38,
//     rules_created: 38,
//     failures: [],
//     apply_all: {ok: true, rules_applied: 38, results: [...]}
//   }
```

Coverage on the typical Hungarian household runs ~55% — the rest is one-off contractor names and unique-merchant purchases that can't be pattern-matched. Top up over time as Sir reviews the long-tail himself.

### Pitfalls

- **The pipeline is *proposals* — review before applying.** It infers from a keyword rulebook. For ambiguous names (a person's name that could be either "contractor I paid" or "income from"), the role might be wrong. Always sanity-check the top 20 by volume before approving.
- **TF-IDF needs corpus density.** On <50 transactions it falls back to shared-token merging, which works but is less discriminating. Don't run the pipeline on a freshly-bootstrapped account with one week of data.
- **`apply_all` runs synchronously after creates.** A 50-rule batch over 3,000 transactions takes ~30 seconds. Acceptable for a Money Day brief, less so for an interactive chat — fire it during quiet hours.
- **Internal transfers (Wise, Revolut, Apple Pay Top-Up, name-based self-transfers) are categorised as "Transfers".** This is convenience-only — Sure's own auto-transfer detection will pair them properly on next sync, at which point the category becomes redundant but not harmful.

### Iterative loop (default mode — multi-pass)

The pipeline now runs as an **iterative loop** by default. Single-pass keyword-only clustering tops out around 50-55% on a real Hungarian household; the loop pushes coverage to **78%+ end-to-end** (measured on david's 3,267 transactions) by combining three signals:

1. **Pass 1 — Keyword + word-TFIDF clustering** (the original pipeline). Cheap, deterministic, catches the obvious anchor-word merchants (Tesco, Wolt, Apple, etc.).
2. **Pass 2 — Behavioural co-occurrence**. Same account + same amount-band + monthly cadence → recurring payment, even if the names differ ("Sp Mind Lab Pro" vs "Sp Mind Lab Pro Eu", "MÓNIKA ARTAI" vs "Mónika Artai Bt."). Returns a group with role but no category.
3. **Pass 3 — LLM category inference**. For any group still without a category (typical: Hungarian individual names, single-occurrence phrases), batched into a single Claude prompt via OpenClaw's `/v1/chat/completions` — returns `{category, tag, role, confidence}` per group. Highest impact on Hungarian-language data.

After each iteration, transactions matched by any high-confidence proposal are removed from the residual corpus and the three passes re-run. The loop stops when:
- coverage ≥ target (default 80%), OR
- a single iteration matches fewer than 5 new transactions (no progress), OR
- 5 iterations completed.

**Tunable via the request body:**

```
self({endpoint: "/api/v1/sure/_cluster", method: "POST", body: {
  iterative: true,                  // default
  target_coverage: 0.80,            // default
  max_iterations: 5,                // default
  use_llm: true,                    // default — set false for pure-deterministic mode
  use_behavioural: true,            // default
  llm_model: "x-ai/grok-4.1-fast",  // override the default OpenClaw model
  available_categories: ["Groceries","Food & Drink",...],  // pass tenant's actual categories
  available_tags: ["Subscription","Transfer",...]          // for the LLM prompt
}})
// → {
//     proposals: [...],
//     stats: [
//       {iteration:1, keyword_proposals:38, behavioural_proposals:12, llm_proposals:24,
//        matched_in_iteration:1820, cumulative_coverage_percent:55.7},
//       {iteration:2, keyword_proposals:6, behavioural_proposals:4, llm_proposals:18,
//        matched_in_iteration:412, cumulative_coverage_percent:68.3},
//       {iteration:3, ..., cumulative_coverage_percent:81.2}
//     ],
//     coverage_percent: 81.2,
//     stopped_reason: "target_coverage_reached"
//   }
```

**Single-pass fallback** is still available with `iterative: false` — same as before, returns immediately without the LLM step. Use this when the OpenClaw gateway is unavailable or when you specifically want deterministic-only output for testing.

### `_cluster/apply` — automatic quality filter

The apply route runs a quality filter before creating any merchants or rules. Verified on david's tenant: an unfiltered apply mis-categorises ~5% of high-volume groups (canonical bad case: a behavioural cluster of 41 unrelated restaurants + baby stores all in the same amount-band gets labelled "Transfers"). The defaults below were the smallest set of filters that dropped all such groups in the david sample without losing any correct ones.

| Body param | Default | Effect |
|---|---|---|
| `min_confidence` | `0.85` | Drop any proposal with `confidence < this`. Tunes the precision/recall trade-off. |
| `drop_low_conf_transfer` | `true` | Drop role=transfer proposals when their confidence is below `low_conf_transfer_threshold` (the LLM is least reliable on transfer-vs-merchant for individual-name clusters). |
| `low_conf_transfer_threshold` | `0.9` | Threshold for the rule above. |
| `drop_canonical_names` | `[]` | Explicit blacklist (lowercased) of canonical names to skip. Use after the first run when you spot a specific bad cluster. |

Response includes:

```
{
  proposals_in: 357,         // raw input
  proposals_kept: 162,       // survived the filter
  proposals_filtered_out: 195,
  filter_reasons: [           // first 50, for debugging
    {canonical_name: "Oliv", reason: "transfer-role with confidence 0.85 < 0.9"},
    ...
  ],
  merchants_created: 90,
  rules_created: 162,
  failures: [],
  apply_all: {ok: true, rules_applied: 162, ...}
}
```

### "Bam, that's it" — bootstrap on a fresh tenant

The full sequence for a freshly-connected Sure account is wrapped in a single composite endpoint:

```
self({endpoint: "/api/v1/sure/_bootstrap", method: "POST"})
// → {
//     ok: true,
//     log: [
//       "step 1: bootstrapping default categories",
//       "step 2: 357 proposals, raw coverage 70%",
//       "step 3: 90 merchants, 162 rules, apply_all rules_applied=162"
//     ],
//     bootstrap_categories: {...},
//     cluster: {coverage_percent: 70, proposals_count: 357, stats: [...], stopped_reason: "..."},
//     apply:   {merchants_created: 90, rules_created: 162, ...}
//   }
```

This is a thin wrapper — it just calls these three steps in order:

1. `POST /api/v1/sure/categories/bootstrap` (idempotent — only runs if Sir has no categories yet).
2. `POST /api/v1/sure/_cluster` (with the actual category + tag names from Sir's family auto-discovered, no need to pass them).
3. `POST /api/v1/sure/_cluster/apply` (the quality filter does its work; no manual review needed for the typical case).

If you want to **review proposals before applying** — say, on a sensitive tenant or one with an unusual transaction history — fall back to the explicit two-step sequence:

```
# Get proposals only
self({endpoint: "/api/v1/sure/_cluster", method: "POST", body: {...}})
# Manually inspect, optionally edit, then:
self({endpoint: "/api/v1/sure/_cluster/apply", method: "POST", body: {proposals: [...]}})
```

Total cost on a 3,000-txn tenant: ~30k LLM tokens (≈$0.10–0.30) + 30 minutes of ctrl-api work. One-shot only — you don't re-run this; from here, Sure's own auto-rule engine handles new transactions as they sync.

All bootstrap params from `/_cluster` and `/_cluster/apply` pass through to `/_bootstrap` — `target_coverage`, `max_iterations`, `llm_top_n`, `min_confidence`, `drop_canonical_names[]`, etc. Empty body works fine for the default-everything case.

### Pitfalls (iterative)

- **LLM pass needs the gateway token mounted in alfred-learn.** It is, on every tenant — but a freshly-bootstrapped instance might race the token write. The pass silently falls back to "no LLM" if `OPENCLAW_GATEWAY_TOKEN_FILE` is empty.
- **Each iteration costs ~3k–10k LLM tokens.** A typical 5-iteration run on 3,000 transactions burns ~30k tokens (~$0.10–0.30 depending on model). Acceptable as a one-shot bootstrap; not as a per-Money-Day chore.
- **The LLM is non-deterministic.** Running the same input twice can produce slightly different category assignments at the margin (especially for ambiguous Hungarian phrases). For deterministic builds, use `iterative: false` or pin a temperature lower than the default 0.1 (not currently exposed — would need a new request param).
- **Ctrl-api timeout is 9 minutes.** A 5-iteration run with LLM is typically 2-4 minutes on 3,000 transactions, but a slow model + large corpus can exceed this. If you hit a 502 timeout, retry with `max_iterations: 3` or split the corpus by date range.
