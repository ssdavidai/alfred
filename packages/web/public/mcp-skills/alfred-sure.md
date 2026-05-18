---
name: alfred-sure
description: Drive Sure (Sir's self-hosted personal-finance app) end-to-end through the MCP `sure` connector. ~80 tools wrapping Sure's Rails surface — accounts, transactions, transfers, splits, bulk edits, categories, tags, merchants, rules, holdings, valuations, recurring transactions, duplicates, account sharing, family invitations, budgets, exports, and admin settings. Use whenever Sir asks about his finances, wants to categorise a transaction, mark something as a transfer, run a rule, see his spending — or when Alfred is operating Sure on Sir's behalf in the background.
license: alfred-platform internal — see the parent monorepo's LICENSE
---

# Sure MCP — operator's manual

You have **~80 Sure tools** through the MCP `sure` connector. They wrap two surfaces:

1. **Sure's public REST API** — read paths plus the thin slice of writes that exist upstream.
2. **Rails-runner-backed mutations** — anything the public API doesn't expose, executed via `bin/rails runner` against `sure-web` through ctrl-api.

Both go through `ctrl-api`'s `/api/v1/sure/*` routes — you never call Sure's REST directly.

The full tool list is much longer than this skill — `tools/list` from the connector enumerates them at runtime. This skill is the operator's framing: when to reach for which family of tools, common pre-reqs, and the gotchas that bite.

## Tool families (high-level)

- **Accounts**: list, get, create, update, destroy. CRUD over Sure accounts (Example Bank EUR, JBC mortgage, etc.).
- **Transactions / entries**: list, get, split, unsplit, bulk_update, bulk_delete. The bulk surface is the right tool for "categorize all 47 of last month's Tesco transactions as Groceries".
- **Transfers**: create, confirm, reject, destroy, match. Two-leg primitive — creating a transfer flips both sides' `kind` to `funds_movement`.
- **Categories / tags / merchants**: bootstrap, create, update, replace_and_destroy, merge. Replace-and-destroy is the right tool for "merge these four duplicate Tesco merchants into one".
- **Rules**: list, get, create, update, destroy, preview, apply, apply_all. Preview before apply when the rule's effect is non-trivial.
- **Holdings**: destroy, set_manual_cost_basis, unlock_cost_basis, remap_security, reset_security_to_provider. Investments surface — read-mostly, but Sir does manually adjust cost basis sometimes.
- **Valuations**: destroy. Other valuation operations are still UI-only upstream.
- **Recurring**: identify, cleanup_stale, mark_active, mark_inactive. Sure's pattern detector; Sir runs this monthly.
- **Duplicates**: merge_duplicate, dismiss_duplicate. Sure flags suspected duplicates; Sir reviews; you action.
- **Account shares**: create, update, delete. Multi-user families.
- **Invitations**: create, destroy. Sir creates → Alfred emails URL → spouse signs up via browser. (Accept is browser-only — see "Skipped" below.)
- **Budgets**: find_or_bootstrap, copy_from, update_category_budget. Monthly budget surface.
- **Exports**: create. Kicks off `FamilyDataExportJob`.
- **Settings**: set_user_pref, set_setting. NUCLEAR-ADJACENT — see warnings below.

## Common flows

**1. "Categorize all Tesco transactions from last month as Groceries"**

```
search Sure transactions where merchant.name == "Tesco" and date in [last month]
  → list of entry ids
bulk_update({ids: [...], category_name: "Groceries"})
```

**2. "Mark this Example Bank→JBC outflow as a loan transfer"**

Creating a transfer requires the source + destination account ids and the matching dates. Use `transfers.match` if both sides already exist as standard transactions; use `transfers.create` if only one side does.

**3. "I want a budget for this month, copy from last month"**

```
find_or_bootstrap({start_date: <this month's first day>})
copy_from({source_budget_id: <last month's budget>})
```

**4. "Merge these duplicate Tesco merchants"**

```
merchant.merge({target: "<canonical-id>", sources: ["<dup-1>", "<dup-2>", ...]})
```

Side effect: every transaction tied to the source merchants is reassigned to the target. Dry-run: list_transactions filtered by merchant_id first if you want to know how many transactions are about to flip.

## Pre-reqs and gotchas

- **`Category.bootstrap!` is a CLASS METHOD on Category, not `family.categories.bootstrap`.** ctrl-api wraps this correctly; just know that the conceptual surface is "bootstrap once per family".
- **`replace_and_destroy` takes the REPLACEMENT object, not the id.** Same for `Tag#replace_and_destroy`. ctrl-api translates the id you send into the object before calling Rails.
- **Bulk operations are atomic at the Rails-runner level.** A `bulk_update` either applies to all 47 entries or none — Rails wraps it in a transaction. Don't batch into smaller groups unless Sir asks.
- **Transfer destroy flips `kind` on BOTH legs back to `standard` — it doesn't delete the underlying transactions.** That's deliberate; the transactions survive even if the transfer association doesn't.
- **`bw login` cycles for Vaultwarden are unrelated.** Don't confuse Sure's API surface with Vaultwarden's. Different connector.
- **Settings mutations require explicit Sir confirmation.** `Setting.<key>=` can break Sure (set wrong DB host, change exchange-rate provider, etc.). Always echo back what you're about to set + why before calling `set_setting`.

## What's deliberately NOT here

- **Transaction → trade conversion.** Sure's `TransactionsController#convert` is 30+ lines of business logic with no model boundary. Reproducing it in Ruby risks silently diverging from upstream. Document UI-only when Sir asks.
- **Family invitation `accept`.** Requires a browser session (token-bearing URL). Sir creates the invitation via the API → Alfred emails it → spouse accepts in browser.
- **`Entry#unlock_for_sync!`** for Trade and Transaction parity. Not present in upstream main at the pinned SHA. Use the lock-aware path through Holdings for now.
- **File uploads, OAuth provider callbacks, password/MFA, billing.** Out of scope for the agent surface.

## Good behaviour

1. **Read before write.** `get_account` / `get_entry` before update so you have current frontmatter to merge — prevents clobbering fields you didn't intend to touch.
2. **Bulk over loop.** When Sir says "categorize all of X as Y", reach for `bulk_update`, not a per-entry update loop.
3. **Preview rules before apply.** Sure's `apply_all` can affect thousands of transactions; you want the preview count first.
4. **Respect locks.** Holdings / cost-basis edits respect `locked_at` markers — `set_manual_cost_basis!` locks; `unlock_cost_basis!` unlocks. Don't fight the lock without asking Sir.
5. **Reply in prose, not envelope.** Sure responses are JSON; Sir wants the answer ("£312 across 47 transactions, all now Groceries"), not the JSON.
