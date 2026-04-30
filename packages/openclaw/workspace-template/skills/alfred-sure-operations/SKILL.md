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
- **No transfer creation.** Sure models loan payments and inter-account moves as `Transfer` records (paired outflow + inflow). There is no `transfer` field on `POST/PATCH /transactions` and no `/transfers` endpoint. Transfer creation is web-UI only — see the Transfers section below.
- **No rule mutations.** Sure has a Rules engine (Settings → Rules) for automated transaction classification (mark-as-transfer, set-category, add-tag, etc.) but the API does not expose it. Sir builds rules in the UI.

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

### Why Alfred can't do this for Sir directly

The Sure REST API exposes only the standard transaction CRUD. Marking a transaction as a transfer (or creating one outright) requires either the web `Transfer::Creator` service or the Rules engine — both UI-managed. If Sir asks you to "mark this as a transfer", the honest answer is: "I can't through the API, but you can in the Sure UI in two clicks — or set up a rule once and never do it again."

The platform may later add a Rails-runner-backed transfer endpoint (similar to how `POST /api/v1/sure/accounts` bypasses Sure's API gap for account creation). Until then, transfers stay UI-only.
