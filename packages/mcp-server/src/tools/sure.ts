// Sure MCP tool catalogue.
//
// One TS object per /api/v1/sure/* endpoint surfaced through david's ctrl-api.
// Source of truth: packages/ctrl/src/api/routes/sure.ts. Descriptions are
// written for Claude Desktop — i.e. for the model to pick the right tool when
// Sir asks a financial question — not for internal docs.
//
// Conventions:
//   - tool names are snake_case
//   - path params come from the input schema and are URL-encoded by buildUrl()
//   - body wrappers (e.g. {transaction: {...}} for Sure REST endpoints) are
//     applied here so the input schema stays flat from the Claude Desktop side
//   - .strict() is intentionally NOT used — additional fields are accepted and
//     forwarded so future ctrl-api fields work without a Worker redeploy
//   - "Backing: REST" / "Backing: Rails-runner" / "Backing: orchestrator"
//     mirrors the ctrl-api route's backing path so model + operator can debug

import { z } from "zod";
import type { ToolDef } from "./types.js";

// ─── shared schema fragments ────────────────────────────────────────────────

const Pagination = {
  page: z.number().int().min(1).optional().describe("1-indexed page number"),
  per_page: z.number().int().min(1).max(100).optional().describe("Page size; default 25, max 100"),
};

const IdParam = z.object({
  id: z.string().min(1).describe("The resource id (UUID or short id from a prior list/get call)"),
});

// Helper for tools that pass query params straight through.
function passthroughQuery(args: Record<string, unknown>): Record<string, unknown> {
  return { ...args };
}

// ─── balance_sheet ──────────────────────────────────────────────────────────

const balanceSheetTools: ToolDef[] = [
  {
    name: "get_balance_sheet",
    description:
      "Returns Sir's net worth in one call: family currency, total net worth, total assets, total liabilities, and the breakdown by classification. Use this when Sir asks 'what's my net worth?' or 'where do I stand?'. Cheap, idempotent, no pagination — call it freely. Backing: REST.",
    inputSchema: z.object({}),
    buildRequest: () => ({ method: "GET", path: "/api/v1/sure/balance_sheet" }),
  },
];

// ─── accounts ───────────────────────────────────────────────────────────────

const accountTools: ToolDef[] = [
  {
    name: "list_accounts",
    description:
      "List every account in Sir's family — banks, brokerages, crypto, property, manual loans — with current balance, currency, classification, accountable_type. Use this whenever Sir asks 'what accounts do I have?' or you need to resolve a human account name to an id before posting a transaction or transfer. Paginated; walk pages if Sir has many accounts. Backing: REST.",
    inputSchema: z.object({
      ...Pagination,
      classification: z.string().optional().describe("'asset' | 'liability'"),
      accountable_type: z.string().optional().describe("Depository | Investment | Crypto | Property | Vehicle | Loan | CreditCard | OtherAsset | OtherLiability"),
      currency: z.string().optional().describe("ISO 4217"),
    }),
    buildRequest: (args) => ({ method: "GET", path: "/api/v1/sure/accounts", query: passthroughQuery(args) }),
  },
  {
    name: "create_manual_account",
    description:
      "Create a manual account that Sure's REST API can't (Sure's REST is GET-only for accounts; creates go through a Rails-runner that calls Sure's ActiveRecord models). Use when Sir says 'add my Example Bank mortgage' or 'track my Budapest flat'. For liabilities, pass the outstanding balance as a positive number — Sure stores liability balances as positives and the classification handles the sign. Backing: Rails-runner.",
    inputSchema: z.object({
      name: z.string().min(1),
      balance: z.number(),
      currency: z.string().min(1).describe("ISO 4217 e.g. HUF"),
      accountable_type: z.string().describe("Depository | Investment | Crypto | Property | Vehicle | Loan | CreditCard | OtherAsset | OtherLiability"),
      classification: z.string().optional().describe("'asset' | 'liability' — usually inferred from accountable_type"),
      subtype: z.string().optional(),
      accountable_attributes: z.record(z.string(), z.unknown()).optional().describe("Loan: {interest_rate, term_months, rate_type}. Depository: {checking|savings} etc."),
    }),
    buildRequest: (args) => ({ method: "POST", path: "/api/v1/sure/accounts", body: args }),
  },
  {
    name: "update_account",
    description:
      "Update any field on a manual account: rename, correct balance, change loan interest rate. Always read it first via list_accounts so Sir confirms it's the right one. Backing: Rails-runner.",
    inputSchema: IdParam.extend({
      name: z.string().optional(),
      balance: z.number().optional(),
      currency: z.string().optional(),
      accountable_type: z.string().optional(),
      classification: z.string().optional(),
      subtype: z.string().optional(),
      accountable_attributes: z.record(z.string(), z.unknown()).optional(),
    }),
    buildRequest: ({ id, ...body }) => ({ method: "PATCH", path: `/api/v1/sure/accounts/${encodeURIComponent(id)}`, body }),
  },
  {
    name: "delete_account",
    description:
      "Soft-delete a manual account (flips status to pending_deletion; async job hard-deletes after). CANNOT delete provider-linked accounts (Lunchflow / Plaid / Binance / etc.) — Sir must unlink the provider in the Sure UI first or the call returns 409. Backing: Rails-runner.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "DELETE", path: `/api/v1/sure/accounts/${encodeURIComponent(id)}` }),
  },
];

// ─── transactions ───────────────────────────────────────────────────────────

const transactionTools: ToolDef[] = [
  {
    name: "list_transactions",
    description:
      "The workhorse read endpoint. Filter Sir's transactions by date range, account, category, merchant, tag, amount bounds, type, or free-text. Use for 'what did I spend on groceries last month?' or 'show me my recent Tesco runs'. ALWAYS narrow with start_date/end_date first — transaction count grows fast and a category-spend question rarely needs more than one month. signed_amount_cents is the field to use for arithmetic (negative = outflow). Backing: REST.",
    inputSchema: z.object({
      start_date: z.string().optional().describe("ISO YYYY-MM-DD"),
      end_date: z.string().optional().describe("ISO YYYY-MM-DD"),
      account_id: z.string().optional(),
      account_ids: z.array(z.string()).optional(),
      category_id: z.string().optional(),
      category_ids: z.array(z.string()).optional(),
      merchant_id: z.string().optional(),
      merchant_ids: z.array(z.string()).optional(),
      tag_ids: z.array(z.string()).optional(),
      min_amount: z.number().optional(),
      max_amount: z.number().optional(),
      type: z.string().optional().describe("'income' | 'expense' | 'transfer'"),
      search: z.string().optional().describe("Free-text against name/description/notes"),
      has_duplicate_suggestion: z.boolean().optional(),
      ...Pagination,
    }),
    buildRequest: (args) => ({ method: "GET", path: "/api/v1/sure/transactions", query: passthroughQuery(args) }),
  },
  {
    name: "get_transaction",
    description: "Retrieve a single transaction by id with full detail (account, category, merchant, tags, transfer link, attachments). Use to confirm Sir means *this* transaction before issuing a PATCH. Backing: REST.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "GET", path: `/api/v1/sure/transactions/${encodeURIComponent(id)}` }),
  },
  {
    name: "create_transaction",
    description:
      "Log a manual transaction — typically a movement that won't show up in any bank feed: cash withdrawals, between-spouse transfers reconciled by hand, one-off reimbursements. Sign the amount to match Sir's intent — €400 cash withdrawn is amount=-400, NOT 400. After write, confirm back to Sir with all four concrete details (amount, account, category, date). Backing: REST.",
    inputSchema: z.object({
      account_id: z.string(),
      date: z.string().describe("ISO YYYY-MM-DD; default today if Sir didn't say"),
      amount: z.number().describe("Signed (negative = outflow), currency-native units"),
      currency: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      notes: z.string().optional(),
      category_id: z.string().optional(),
      merchant_id: z.string().optional(),
      tag_ids: z.array(z.string()).optional(),
      nature: z.string().optional().describe("'inflow' | 'outflow' | 'transfer'"),
    }),
    buildRequest: (args) => ({ method: "POST", path: "/api/v1/sure/transactions", body: { transaction: args } }),
  },
  {
    name: "update_transaction",
    description:
      "Recategorise, rename, retag, or correct the amount/date on a single transaction. ALWAYS read the transaction first via get_transaction — multiple Tesco runs land each week and Sir means a specific one. Only include fields you're changing. Backing: REST.",
    inputSchema: IdParam.extend({
      date: z.string().optional(),
      amount: z.number().optional(),
      currency: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      notes: z.string().optional(),
      category_id: z.string().optional(),
      merchant_id: z.string().optional(),
      tag_ids: z.array(z.string()).optional(),
      nature: z.string().optional(),
    }),
    buildRequest: ({ id, ...body }) => ({ method: "PATCH", path: `/api/v1/sure/transactions/${encodeURIComponent(id)}`, body: { transaction: body } }),
  },
  {
    name: "delete_transaction",
    description: "Permanently delete a single transaction. Use ONLY when Sir explicitly asks to remove an entry. Prefer merge_duplicate_transaction for pending-vs-posted reconciliation. No undo. Backing: REST.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "DELETE", path: `/api/v1/sure/transactions/${encodeURIComponent(id)}` }),
  },
  {
    name: "split_transaction",
    description:
      "Split a parent transaction into multiple children — a 25,000 Ft Tesco run was 18,000 Ft groceries + 7,000 Ft cleaning supplies. Sum of splits[].amount MUST equal the parent amount; Sure returns 422 if not. Currency inherits from the parent. Backing: Rails-runner.",
    inputSchema: IdParam.extend({
      splits: z.array(z.object({
        name: z.string(),
        amount: z.number(),
        category_id: z.string().optional(),
        merchant_id: z.string().optional(),
        tag_ids: z.array(z.string()).optional(),
        notes: z.string().optional(),
      })).min(2),
    }),
    buildRequest: ({ id, splits }) => ({ method: "POST", path: `/api/v1/sure/transactions/${encodeURIComponent(id)}/split`, body: { splits } }),
  },
  {
    name: "unsplit_transaction",
    description: "Restore a previously-split parent transaction by destroying all its children. Calling on an already-unsplit transaction returns a clean error. Backing: Rails-runner.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "POST", path: `/api/v1/sure/transactions/${encodeURIComponent(id)}/unsplit` }),
  },
  {
    name: "bulk_update_transactions",
    description:
      "Reclassify or relabel many transactions in one call. Use when Sir says 'categorise all March Tesco transactions as Groceries'. Permitted attributes: date, notes, name, category_id, merchant_id, tag_ids. Pass empty tag_ids array to clear tags, omit to leave alone. For recurring patterns affecting 3+ transactions, prefer create_rule so future imports auto-classify too. Backing: Rails-runner.",
    inputSchema: z.object({
      transaction_ids: z.array(z.string()).min(1),
      attributes: z.object({
        date: z.string().optional(),
        notes: z.string().optional(),
        name: z.string().optional(),
        category_id: z.string().optional(),
        merchant_id: z.string().optional(),
        tag_ids: z.array(z.string()).optional(),
      }),
    }),
    buildRequest: (args) => ({ method: "POST", path: "/api/v1/sure/transactions/bulk_update", body: args }),
  },
  {
    name: "bulk_delete_transactions",
    description: "Delete many transactions in one call. REFUSES split children — unsplit the parent first. No undo. Confirm with Sir before running on more than a handful. Backing: Rails-runner.",
    inputSchema: z.object({
      transaction_ids: z.array(z.string()).min(1),
    }),
    buildRequest: (args) => ({ method: "POST", path: "/api/v1/sure/transactions/bulk_delete", body: args }),
  },
];

// ─── duplicates ─────────────────────────────────────────────────────────────

const duplicateTools: ToolDef[] = [
  {
    name: "merge_duplicate_transaction",
    description:
      "Confirm a pending bank-feed transaction and a posted one are the same money movement — destroys the pending entry, keeps the posted one. Use during Money Day pending-review. Returns 422 if no duplicate suggestion exists (call list_transactions with has_duplicate_suggestion: true to find candidates). NO UNDO. Backing: Rails-runner.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "POST", path: `/api/v1/sure/transactions/${encodeURIComponent(id)}/merge_duplicate` }),
  },
  {
    name: "dismiss_duplicate_transaction",
    description: "Tell Sure that a pending transaction's duplicate suggestion is wrong — these are two separate movements. Sets extra.potential_posted_match.dismissed=true so the suggestion stops appearing. Backing: Rails-runner.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "POST", path: `/api/v1/sure/transactions/${encodeURIComponent(id)}/dismiss_duplicate` }),
  },
];

// ─── categories ─────────────────────────────────────────────────────────────

const categoryTools: ToolDef[] = [
  {
    name: "list_categories",
    description:
      "List Sir's spending and income categories with id, name, classification, color, icon, parent, subcategories_count. Use to resolve a category name to an id, surface Sir's category tree, or verify a category exists. roots_only=true collapses subcategories; parent_id walks children. Backing: REST.",
    inputSchema: z.object({
      classification: z.string().optional().describe("'expense' | 'income' | 'transfer'"),
      roots_only: z.boolean().optional(),
      parent_id: z.string().optional(),
    }),
    buildRequest: (args) => ({ method: "GET", path: "/api/v1/sure/categories", query: passthroughQuery(args) }),
  },
  {
    name: "get_category",
    description: "Retrieve a single category by id. Backing: REST.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "GET", path: `/api/v1/sure/categories/${encodeURIComponent(id)}` }),
  },
  {
    name: "bootstrap_default_categories",
    description:
      "Seed Sir's family with the canonical default category set IF his family currently has none. Idempotent. Use on first-time tenant setup before clustering, or when Sir says 'set me up with sensible defaults'. Backing: Rails-runner.",
    inputSchema: z.object({}),
    buildRequest: () => ({ method: "POST", path: "/api/v1/sure/categories/bootstrap" }),
  },
  {
    name: "create_category",
    description:
      "Create a spending or income category. Sure's REST is GET-only for categories so this goes through Rails-runner. Pass parent_id to nest under an existing category. Backing: Rails-runner.",
    inputSchema: z.object({
      name: z.string(),
      classification: z.string().describe("'income' | 'expense'"),
      color: z.string().optional().describe("hex e.g. #6b7280"),
      lucide_icon: z.string().optional(),
      parent_id: z.string().optional(),
    }),
    buildRequest: (args) => ({ method: "POST", path: "/api/v1/sure/categories", body: args }),
  },
  {
    name: "update_category",
    description: "Rename, recolor, change icon, or re-parent a category. Backing: Rails-runner.",
    inputSchema: IdParam.extend({
      name: z.string().optional(),
      classification: z.string().optional(),
      color: z.string().optional(),
      lucide_icon: z.string().optional(),
      parent_id: z.string().optional(),
    }),
    buildRequest: ({ id, ...body }) => ({ method: "PATCH", path: `/api/v1/sure/categories/${encodeURIComponent(id)}`, body }),
  },
  {
    name: "delete_category",
    description:
      "Destroy a category and (optionally) replace it on every affected transaction with a different category. Pass replacement_id so transactions don't get orphaned — without it, transactions become uncategorised. Backing: Rails-runner.",
    inputSchema: IdParam.extend({
      replacement_id: z.string().optional(),
    }),
    buildRequest: ({ id, replacement_id }) => ({
      method: "DELETE",
      path: `/api/v1/sure/categories/${encodeURIComponent(id)}`,
      query: replacement_id ? { replacement_id } : undefined,
    }),
  },
];

// ─── merchants ──────────────────────────────────────────────────────────────

const merchantTools: ToolDef[] = [
  {
    name: "list_merchants",
    description:
      "List every merchant — both Sure's auto-detected ProviderMerchant rows (read-only) and Sir's custom FamilyMerchant rows. Use to resolve 'Tesco' to its merchant id, then call list_transactions?merchant_id=<id>. Cheaper than free-text search for repeat merchants. Backing: REST.",
    inputSchema: z.object({ ...Pagination }),
    buildRequest: (args) => ({ method: "GET", path: "/api/v1/sure/merchants", query: passthroughQuery(args) }),
  },
  {
    name: "get_merchant",
    description: "Retrieve a single merchant by id. Backing: REST.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "GET", path: `/api/v1/sure/merchants/${encodeURIComponent(id)}` }),
  },
  {
    name: "create_family_merchant",
    description:
      "Create a custom FamilyMerchant — Sir's own merchant entry, distinct from auto-detected provider merchants. Use when Sir says 'add my friend Mónika as a merchant'. website_url triggers automatic logo fetch. Backing: Rails-runner.",
    inputSchema: z.object({
      name: z.string(),
      color: z.string().optional(),
      website_url: z.string().optional(),
    }),
    buildRequest: (args) => ({ method: "POST", path: "/api/v1/sure/merchants", body: args }),
  },
  {
    name: "update_family_merchant",
    description: "Rename, recolor, or rewrite the website_url of a FamilyMerchant. ONLY works on family merchants — provider merchants are read-only. Backing: Rails-runner.",
    inputSchema: IdParam.extend({
      name: z.string().optional(),
      color: z.string().optional(),
      website_url: z.string().optional(),
    }),
    buildRequest: ({ id, ...body }) => ({ method: "PATCH", path: `/api/v1/sure/merchants/${encodeURIComponent(id)}`, body }),
  },
  {
    name: "delete_family_merchant",
    description: "Destroy a custom FamilyMerchant. Affected transactions keep their string label but lose the merchant link. Use merge_merchants instead if Sir wants the transactions reassigned. Backing: Rails-runner.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "DELETE", path: `/api/v1/sure/merchants/${encodeURIComponent(id)}` }),
  },
  {
    name: "merge_merchants",
    description:
      "Merge duplicate merchant rows into one canonical merchant — every transaction tagged with a source merchant gets reassigned to the target, then sources are destroyed. Use when Sir has Tesco / Tesco Express / TESCO / Tesco Stores Ltd as four separate rows. Backing: Rails-runner.",
    inputSchema: z.object({
      target_merchant_id: z.string(),
      source_merchant_ids: z.array(z.string()).min(1),
    }),
    buildRequest: (args) => ({ method: "POST", path: "/api/v1/sure/merchants/merge", body: args }),
  },
  {
    name: "enhance_provider_merchants",
    description:
      "Enqueue EnhanceProviderMerchantsJob to refresh logos and metadata on Sure's auto-detected ProviderMerchant rows. Asynchronous. Use after a big bank-feed sync introduced lots of new providers. Backing: Rails-runner.",
    inputSchema: z.object({}),
    buildRequest: () => ({ method: "POST", path: "/api/v1/sure/merchants/enhance" }),
  },
];

// ─── tags ───────────────────────────────────────────────────────────────────

const tagTools: ToolDef[] = [
  {
    name: "list_tags",
    description: "List all transaction tags with id, name, color. Use to resolve a tag name to an id before filtering or tagging. Backing: REST.",
    inputSchema: z.object({ ...Pagination }),
    buildRequest: (args) => ({ method: "GET", path: "/api/v1/sure/tags", query: passthroughQuery(args) }),
  },
  {
    name: "get_tag",
    description: "Retrieve a single tag by id. Backing: REST.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "GET", path: `/api/v1/sure/tags/${encodeURIComponent(id)}` }),
  },
  {
    name: "create_tag",
    description: "Create a new transaction tag. Use when Sir says 'add a Travel tag'. Backing: REST.",
    inputSchema: z.object({
      name: z.string(),
      color: z.string().optional(),
    }),
    buildRequest: (args) => ({ method: "POST", path: "/api/v1/sure/tags", body: { tag: args } }),
  },
  {
    name: "update_tag",
    description: "Rename or recolor a tag. Backing: REST.",
    inputSchema: IdParam.extend({
      name: z.string().optional(),
      color: z.string().optional(),
    }),
    buildRequest: ({ id, ...body }) => ({ method: "PATCH", path: `/api/v1/sure/tags/${encodeURIComponent(id)}`, body: { tag: body } }),
  },
  {
    name: "delete_tag",
    description: "Delete a tag. Affected transactions lose the association. Use merge_tags instead to keep transactions tagged. Backing: REST.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "DELETE", path: `/api/v1/sure/tags/${encodeURIComponent(id)}` }),
  },
  {
    name: "merge_tags",
    description: "Merge a duplicate tag into a canonical one. ONE-WAY destruction. Confirm replacement_id via list_tags first. Backing: Rails-runner.",
    inputSchema: z.object({
      id: z.string().min(1).describe("source tag id (the one being merged AWAY)"),
      replacement_id: z.string().min(1).describe("target/canonical tag id (the one being kept)"),
    }),
    buildRequest: ({ id, replacement_id }) => ({
      method: "POST",
      path: `/api/v1/sure/tags/${encodeURIComponent(id)}/merge_into/${encodeURIComponent(replacement_id)}`,
    }),
  },
];

// ─── rules ──────────────────────────────────────────────────────────────────

const RuleCondition = z.object({
  condition_type: z.string().describe("transaction_name | transaction_amount | transaction_type | transaction_merchant | transaction_category | transaction_account | transaction_details | transaction_notes | compound"),
  operator: z.string().describe("'=' | 'like' | '>' | '>=' | '<' | '<=' | 'is_null'"),
  value: z.string().optional(),
  sub_conditions: z.array(z.unknown()).optional().describe("present only for condition_type=compound"),
});

const RuleAction = z.object({
  action_type: z.string().describe("set_as_transfer_or_payment | set_transaction_category | set_transaction_tags | set_transaction_merchant | set_transaction_name | exclude_transaction | set_investment_activity_label | auto_categorize | auto_detect_merchants"),
  value: z.string().optional(),
});

const ruleTools: ToolDef[] = [
  {
    name: "list_rules",
    description: "List Sir's family rules (newest first), with conditions, actions, active status. Use to audit rules or before creating new ones to avoid duplicates. Backing: Rails-runner.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(500).optional().describe("default 100"),
    }),
    buildRequest: (args) => ({ method: "GET", path: "/api/v1/sure/rules", query: passthroughQuery(args) }),
  },
  {
    name: "get_rule",
    description: "Show one rule with its conditions, actions, and the count of transactions it has affected. Backing: Rails-runner.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "GET", path: `/api/v1/sure/rules/${encodeURIComponent(id)}` }),
  },
  {
    name: "create_rule",
    description:
      "Create a new auto-classification rule. Sure's Rules engine evaluates conditions on every newly-imported transaction (and on demand via apply_rule / apply_all_rules) and applies the actions when conditions match. ALWAYS run preview_rule first with the same body so Sir sees the affected count. Use set_as_transfer_or_payment for monthly debt payments — Sure auto-derives the transfer kind from the destination account. Backing: Rails-runner.",
    inputSchema: z.object({
      name: z.string(),
      resource_type: z.string().describe("'transaction' is the only supported value today"),
      active: z.boolean().optional().describe("default true"),
      effective_date: z.string().optional().describe("ISO YYYY-MM-DD; only txns on/after this date are evaluated"),
      conditions: z.array(RuleCondition).min(1),
      actions: z.array(RuleAction).min(1),
    }),
    buildRequest: (args) => ({ method: "POST", path: "/api/v1/sure/rules", body: args }),
  },
  {
    name: "update_rule",
    description:
      "Update a rule's name, active flag, effective_date, conditions, or actions. CRUCIAL: conditions and actions are REPLACED WHOLESALE when supplied — pass the full new array, not a diff. Backing: Rails-runner.",
    inputSchema: IdParam.extend({
      name: z.string().optional(),
      active: z.boolean().optional(),
      effective_date: z.string().optional(),
      conditions: z.array(RuleCondition).optional(),
      actions: z.array(RuleAction).optional(),
    }),
    buildRequest: ({ id, ...body }) => ({ method: "PATCH", path: `/api/v1/sure/rules/${encodeURIComponent(id)}`, body }),
  },
  {
    name: "delete_rule",
    description: "Delete a rule. Existing transactions previously affected by the rule keep their classification (the rule's effects are not reverted). Backing: Rails-runner.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "DELETE", path: `/api/v1/sure/rules/${encodeURIComponent(id)}` }),
  },
  {
    name: "preview_rule",
    description:
      "Dry-run a rule definition WITHOUT saving it — returns affected_resource_count and a sample of up to 20 matching transactions. USE THIS BEFORE EVERY create_rule so Sir can sanity-check the count and the sample. Don't save a rule that would affect 200 transactions when Sir asked for 'just the mortgage'. Backing: Rails-runner.",
    inputSchema: z.object({
      name: z.string().optional(),
      resource_type: z.string().describe("'transaction'"),
      effective_date: z.string().optional(),
      conditions: z.array(RuleCondition).min(1),
      actions: z.array(RuleAction).min(1),
    }),
    buildRequest: (args) => ({ method: "POST", path: "/api/v1/sure/rules/preview", body: args }),
  },
  {
    name: "apply_rule",
    description:
      "Re-run a single rule against ALL historical transactions (not just new ones). Use immediately after create_rule so the new rule fans across past data. ignore_attribute_locks: true overrides Sir's manual edit-locks — only set when Sir explicitly says 'replay over my edits too'. Backing: Rails-runner.",
    inputSchema: IdParam.extend({
      ignore_attribute_locks: z.boolean().optional().describe("default false"),
    }),
    buildRequest: ({ id, ignore_attribute_locks }) => ({
      method: "POST",
      path: `/api/v1/sure/rules/${encodeURIComponent(id)}/apply`,
      body: ignore_attribute_locks !== undefined ? { ignore_attribute_locks } : undefined,
    }),
  },
  {
    name: "apply_all_rules",
    description:
      "Run EVERY family rule against historical transactions in one pass. Synchronous — can take 30+ seconds on a busy family. Use after a CSV import or after creating multiple rules in a batch. Backing: Rails-runner.",
    inputSchema: z.object({
      ignore_attribute_locks: z.boolean().optional().describe("default false"),
    }),
    buildRequest: (args) => ({ method: "POST", path: "/api/v1/sure/rules/apply_all", body: args }),
  },
];

// ─── holdings + trades ──────────────────────────────────────────────────────

const holdingTools: ToolDef[] = [
  {
    name: "list_holdings",
    description: "List investment holdings (positions) — each carries account, security, qty, cost_basis, current_value, currency. Use for 'what are my positions?' or 'how's AAPL doing?'. Backing: REST.",
    inputSchema: z.object({
      account_id: z.string().optional(),
      ...Pagination,
    }),
    buildRequest: (args) => ({ method: "GET", path: "/api/v1/sure/holdings", query: passthroughQuery(args) }),
  },
  {
    name: "get_holding",
    description: "Retrieve a single holding with full detail — security, account, qty, cost_basis, cost_basis_source, cost_basis_locked, current_value. Backing: REST.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "GET", path: `/api/v1/sure/holdings/${encodeURIComponent(id)}` }),
  },
  {
    name: "delete_holding",
    description:
      "Destroy a holding AND every trade entry that produced it. Use ONLY when Sir explicitly wants to wipe the position, NOT to 'hide it temporarily'. Backing: Rails-runner.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "DELETE", path: `/api/v1/sure/holdings/${encodeURIComponent(id)}` }),
  },
  {
    name: "set_holding_manual_cost_basis",
    description:
      "Set the per-share cost basis on a holding manually and lock it so provider syncs can't overwrite. CRUCIAL: value is the PER-SHARE cost basis, not the total — Sir is likely to say 'my total cost was $14,732' and you must convert by dividing by qty. Backing: Rails-runner.",
    inputSchema: IdParam.extend({
      value: z.string().describe("per-share cost basis as decimal string e.g. '147.32'"),
    }),
    buildRequest: ({ id, value }) => ({ method: "POST", path: `/api/v1/sure/holdings/${encodeURIComponent(id)}/set_manual_cost_basis`, body: { value } }),
  },
  {
    name: "unlock_holding_cost_basis",
    description: "Clear the manual cost-basis lock on a holding so provider/calculated cost basis can take over again on the next sync. Backing: Rails-runner.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "POST", path: `/api/v1/sure/holdings/${encodeURIComponent(id)}/unlock_cost_basis` }),
  },
  {
    name: "remap_holding_security",
    description:
      "Move a holding (and every trade for the same security) to a different security definition. Use when broker reported a synthetic ticker but the real instrument is e.g. VOO on XNAS. WARNING: trades move too — if Sir already had real trades on the target security, those keep their qty/amount but co-locate, which can produce a holding that doesn't match either history. Confirm before remapping a security with non-trivial trade history. Pass either security_id directly OR (ticker + exchange_operating_mic). Backing: Rails-runner.",
    inputSchema: IdParam.extend({
      security_id: z.string().optional(),
      ticker: z.string().optional(),
      exchange_operating_mic: z.string().optional().describe("e.g. 'XNAS' for Nasdaq"),
    }),
    buildRequest: ({ id, ...body }) => ({ method: "POST", path: `/api/v1/sure/holdings/${encodeURIComponent(id)}/remap_security`, body }),
  },
  {
    name: "reset_holding_security_to_provider",
    description:
      "Revert a manual security remap — restores the original provider_security_id and unlocks the holding. Only valid when provider_security_id is set; returns 422 otherwise. Backing: Rails-runner.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "POST", path: `/api/v1/sure/holdings/${encodeURIComponent(id)}/reset_security_to_provider` }),
  },
];

const tradeTools: ToolDef[] = [
  {
    name: "list_trades",
    description: "List investment trades (buy/sell entries) with security, qty, price, date. Use for 'what trades did I make this quarter?'. Backing: REST.",
    inputSchema: z.object({
      account_id: z.string().optional(),
      ...Pagination,
    }),
    buildRequest: (args) => ({ method: "GET", path: "/api/v1/sure/trades", query: passthroughQuery(args) }),
  },
  {
    name: "get_trade",
    description: "Retrieve a single trade by id. Backing: REST.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "GET", path: `/api/v1/sure/trades/${encodeURIComponent(id)}` }),
  },
  {
    name: "create_trade",
    description:
      "Record an investment trade (buy or sell). Sign qty to match intent: positive = buy, negative = sell. Sure auto-creates or updates the corresponding holding. Backing: REST.",
    inputSchema: z.object({
      account_id: z.string(),
      date: z.string().describe("ISO YYYY-MM-DD"),
      qty: z.number().describe("Signed: positive = buy, negative = sell"),
      price: z.number().describe("Per-share"),
      currency: z.string().optional(),
      security_id: z.string().optional(),
      ticker: z.string().optional(),
      exchange_operating_mic: z.string().optional(),
      name: z.string().optional(),
      notes: z.string().optional(),
    }),
    buildRequest: (args) => ({ method: "POST", path: "/api/v1/sure/trades", body: { trade: args } }),
  },
  {
    name: "update_trade",
    description: "Update a single trade — correct date, qty, price, etc. Holding qty/cost-basis recalculate on save. Backing: REST.",
    inputSchema: IdParam.extend({
      date: z.string().optional(),
      qty: z.number().optional(),
      price: z.number().optional(),
      currency: z.string().optional(),
      security_id: z.string().optional(),
      name: z.string().optional(),
      notes: z.string().optional(),
    }),
    buildRequest: ({ id, ...body }) => ({ method: "PATCH", path: `/api/v1/sure/trades/${encodeURIComponent(id)}`, body: { trade: body } }),
  },
  {
    name: "delete_trade",
    description: "Delete a single trade. The corresponding holding's qty and cost basis recalculate on save. Backing: REST.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "DELETE", path: `/api/v1/sure/trades/${encodeURIComponent(id)}` }),
  },
];

// ─── valuations ─────────────────────────────────────────────────────────────

const valuationTools: ToolDef[] = [
  {
    name: "create_valuation",
    description:
      "Mark a balance for an illiquid asset that has no live feed — the Budapest flat, crypto in a cold wallet, a private-company stake. Posting a valuation re-marks the account's balance to that amount on that date. CRUCIAL: amount is in currency-native units (HUF for HUF property, USD for USD-denominated). Confirm currency with Sir if it isn't obvious from the account. Backing: REST.",
    inputSchema: z.object({
      account_id: z.string(),
      date: z.string().describe("ISO YYYY-MM-DD"),
      amount: z.number(),
      currency: z.string().optional(),
      notes: z.string().optional(),
    }),
    buildRequest: (args) => ({ method: "POST", path: "/api/v1/sure/valuations", body: { valuation: args } }),
  },
  {
    name: "get_valuation",
    description: "Retrieve a single valuation entry. Backing: REST.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "GET", path: `/api/v1/sure/valuations/${encodeURIComponent(id)}` }),
  },
  {
    name: "update_valuation",
    description: "Correct a previously-logged valuation — change the amount, date, or notes. Backing: REST.",
    inputSchema: IdParam.extend({
      date: z.string().optional(),
      amount: z.number().optional(),
      currency: z.string().optional(),
      notes: z.string().optional(),
    }),
    buildRequest: ({ id, ...body }) => ({ method: "PATCH", path: `/api/v1/sure/valuations/${encodeURIComponent(id)}`, body: { valuation: body } }),
  },
  {
    name: "delete_valuation",
    description:
      "Destroy a valuation snapshot. CRUCIAL: the id here is the Entry id (Sure models valuations as a delegated_type on Entry), NOT a separate valuation id — get it from list_transactions?account_id=<asset> and look for the Valuation entry. Returns 422 if the entry isn't actually a Valuation. Backing: Rails-runner.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "DELETE", path: `/api/v1/sure/valuations/${encodeURIComponent(id)}` }),
  },
];

// ─── transfers ──────────────────────────────────────────────────────────────

const transferTools: ToolDef[] = [
  {
    name: "create_transfer",
    description:
      "Create a fresh transfer — pairs an outflow on source_account_id with an inflow on destination_account_id. Sure auto-derives the transfer kind from the destination: liability → loan_payment, credit card → cc_payment, investment → investment_contribution, otherwise funds_movement. Use for 'log the May mortgage payment, 370,847 Ft from Example Bank to Example Mortgage'. Both legs are generated; transfers are excluded from spending totals. Backing: Rails-runner.",
    inputSchema: z.object({
      source_account_id: z.string(),
      destination_account_id: z.string(),
      amount: z.union([z.string(), z.number()]),
      date: z.string().describe("ISO YYYY-MM-DD"),
      exchange_rate: z.union([z.string(), z.number()]).optional().describe("required if accounts have different currencies and Sure has no rate for the date"),
    }),
    buildRequest: (args) => ({ method: "POST", path: "/api/v1/sure/transfers", body: args }),
  },
  {
    name: "match_transfer",
    description:
      "Pair two EXISTING transactions as a transfer (find_or_initialize_by). Use when the bank feed already imported the outflow and inflow as separate transactions and Sir says 'these are the same money movement'. Sure validates opposite amounts and date proximity. If you're creating both legs from scratch, use create_transfer instead. Backing: Rails-runner.",
    inputSchema: z.object({
      inflow_transaction_id: z.string(),
      outflow_transaction_id: z.string(),
    }),
    buildRequest: (args) => ({ method: "POST", path: "/api/v1/sure/transfers/match", body: args }),
  },
  {
    name: "confirm_transfer",
    description:
      "Confirm a pending (auto-detected) transfer. Sure's auto-matcher creates pending transfers when it sees probable pairs. Always preview both legs first via get_transaction and confirm with Sir. Backing: Rails-runner.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "POST", path: `/api/v1/sure/transfers/${encodeURIComponent(id)}/confirm` }),
  },
  {
    name: "reject_transfer",
    description: "Reject a pending transfer — destroys the Transfer row and records a RejectedTransfer so Sure's matcher won't suggest the same pair again. Backing: Rails-runner.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "POST", path: `/api/v1/sure/transfers/${encodeURIComponent(id)}/reject` }),
  },
  {
    name: "delete_transfer",
    description: "Destroy a confirmed transfer. Both legs flip back to kind:standard (regular spending/income transactions) and the destination account's balance recovers. Backing: Rails-runner.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "DELETE", path: `/api/v1/sure/transfers/${encodeURIComponent(id)}` }),
  },
];

// ─── recurring ──────────────────────────────────────────────────────────────

const recurringTools: ToolDef[] = [
  {
    name: "identify_recurring_patterns",
    description:
      "Run Sure's recurring-pattern detection synchronously. Returns count of patterns identified plus the family's currently-active recurring list. SYNCHRONOUS and can take 10-20s on a large family — trigger during quiet windows (Money Day brief), not in the middle of an interactive chat. Backing: Rails-runner.",
    inputSchema: z.object({}),
    buildRequest: () => ({ method: "POST", path: "/api/v1/sure/recurring/identify" }),
  },
  {
    name: "cleanup_stale_recurring",
    description: "Mark recurring transactions inactive when their last occurrence is too old. Use for periodic hygiene. Backing: Rails-runner.",
    inputSchema: z.object({}),
    buildRequest: () => ({ method: "POST", path: "/api/v1/sure/recurring/cleanup_stale" }),
  },
  {
    name: "activate_recurring",
    description: "Re-enable a previously-deactivated recurring. Use when Sir says 'I restarted Netflix — reactivate that pattern'. Backing: Rails-runner.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "POST", path: `/api/v1/sure/recurring/${encodeURIComponent(id)}/activate` }),
  },
  {
    name: "deactivate_recurring",
    description: "Hide a recurring without deleting it. Pattern stays in DB (so reactivation is one call away) but is excluded from upcoming-bills and recurring-spend rollups. Backing: Rails-runner.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "POST", path: `/api/v1/sure/recurring/${encodeURIComponent(id)}/deactivate` }),
  },
];

// ─── shares ─────────────────────────────────────────────────────────────────

const shareTools: ToolDef[] = [
  {
    name: "create_account_share",
    description:
      "Grant per-account access to another family member. The target user MUST already be a member of Sir's family — invite them via create_invitation first if not. include_in_finances: false means the spouse sees the account but it doesn't roll up into their net worth. Backing: Rails-runner.",
    inputSchema: z.object({
      account_id: z.string().describe("the account being shared"),
      email: z.string().optional().describe("EITHER email OR user_id required"),
      user_id: z.string().optional(),
      permission: z.string().optional().describe("'read_only' (default) | 'read_write' | 'full_control'"),
      include_in_finances: z.boolean().optional().describe("default true"),
    }),
    buildRequest: ({ account_id, ...body }) => ({
      method: "POST",
      path: `/api/v1/sure/accounts/${encodeURIComponent(account_id)}/shares`,
      body,
    }),
  },
  {
    name: "update_account_share",
    description: "Update an existing share's permission level or include_in_finances flag. Backing: Rails-runner.",
    inputSchema: IdParam.extend({
      permission: z.string().optional(),
      include_in_finances: z.boolean().optional(),
    }),
    buildRequest: ({ id, ...body }) => ({ method: "PATCH", path: `/api/v1/sure/shares/${encodeURIComponent(id)}`, body }),
  },
  {
    name: "delete_account_share",
    description: "Revoke an account share. Backing: Rails-runner.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "DELETE", path: `/api/v1/sure/shares/${encodeURIComponent(id)}` }),
  },
];

// ─── invitations ────────────────────────────────────────────────────────────

const invitationTools: ToolDef[] = [
  {
    name: "create_invitation",
    description:
      "Invite a new member to Sir's Sure family. Returns the encrypted token and a relative accept_url_path so Sir can email the invitee a usable URL. The invitee opens the URL in their browser to accept — the accept step is intentionally NOT exposed via API because Sure's Invitation#accept_for(user) requires a token-bearing browser session. Backing: Rails-runner.",
    inputSchema: z.object({
      email: z.string(),
      role: z.string().optional().describe("'admin' | 'member' (default) | 'guest'"),
    }),
    buildRequest: (args) => ({ method: "POST", path: "/api/v1/sure/invitations", body: args }),
  },
  {
    name: "delete_invitation",
    description: "Revoke a pending invitation before it's accepted. Backing: Rails-runner.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "DELETE", path: `/api/v1/sure/invitations/${encodeURIComponent(id)}` }),
  },
];

// ─── budgets ────────────────────────────────────────────────────────────────

const budgetTools: ToolDef[] = [
  {
    name: "find_or_bootstrap_budget",
    description:
      "Idempotent budget setup. Creates the Budget shell and BudgetCategory rows from the current category set if missing for that month, returns the existing budget if it already exists. CRUCIAL: valid window is [max(2y ago, oldest_entry_date), 2y ahead]. Backing: Rails-runner.",
    inputSchema: z.object({
      start_date: z.string().describe("ISO YYYY-MM-01 (start of month)"),
    }),
    buildRequest: (args) => ({ method: "POST", path: "/api/v1/sure/budgets/find_or_bootstrap", body: args }),
  },
  {
    name: "copy_budget_from",
    description:
      "Clone budgeted_spending values from a prior month's budget into this one. CRUCIAL: only copies amounts, NOT category structure — if the target budget has new categories the source didn't, those stay at 0. Backing: Rails-runner.",
    inputSchema: IdParam.extend({
      source_budget_id: z.string(),
    }),
    buildRequest: ({ id, source_budget_id }) => ({
      method: "POST",
      path: `/api/v1/sure/budgets/${encodeURIComponent(id)}/copy_from`,
      body: { source_budget_id },
    }),
  },
  {
    name: "update_budget_category",
    description:
      "Set the per-category target amount for one budget category (e.g. Groceries this month). Pass the amount as a decimal string. Currency inherits from the parent budget. Backing: Rails-runner.",
    inputSchema: IdParam.extend({
      budgeted_spending: z.string().describe("Decimal string e.g. '275000.00'"),
    }),
    buildRequest: ({ id, budgeted_spending }) => ({
      method: "PATCH",
      path: `/api/v1/sure/budget_categories/${encodeURIComponent(id)}`,
      body: { budgeted_spending },
    }),
  },
];

// ─── imports ────────────────────────────────────────────────────────────────

const importTools: ToolDef[] = [
  {
    name: "list_imports",
    description: "List CSV bulk imports with status (pending / processing / completed / failed). Backing: REST.",
    inputSchema: z.object({ ...Pagination }),
    buildRequest: (args) => ({ method: "GET", path: "/api/v1/sure/imports", query: passthroughQuery(args) }),
  },
  {
    name: "create_import",
    description:
      "Create a CSV bulk-import job. Use when Sir hands you a CSV from his old bank or brokerage. Asynchronous — returns the import row in pending status; poll via get_import. After completion, run apply_all_rules so the new history gets categorised. Backing: REST.",
    inputSchema: z.object({
      account_id: z.string(),
      raw_file_str: z.string().optional().describe("CSV contents inline OR signed_id from a prior upload"),
      signed_id: z.string().optional(),
      column_mappings: z.record(z.string(), z.unknown()).optional(),
      date_format: z.string().optional().describe("e.g. '%m/%d/%Y'"),
      name: z.string().optional(),
    }),
    buildRequest: (args) => ({ method: "POST", path: "/api/v1/sure/imports", body: { import: args } }),
  },
  {
    name: "get_import",
    description: "Retrieve a CSV import's status and parsed rows. Use to check whether an import has completed before running apply_all_rules. Backing: REST.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "GET", path: `/api/v1/sure/imports/${encodeURIComponent(id)}` }),
  },
];

// ─── exports ────────────────────────────────────────────────────────────────

const exportTools: ToolDef[] = [
  {
    name: "create_export",
    description:
      "Create a FamilyExport row and enqueue FamilyDataExportJob — produces a zip of transactions, accounts, holdings, recurring transactions. Returns the export with status=pending. ASYNCHRONOUS — return the export id to Sir; let him ask 'is it ready?' in a later turn (poll the Sure UI). Backing: Rails-runner.",
    inputSchema: z.object({}),
    buildRequest: () => ({ method: "POST", path: "/api/v1/sure/exports" }),
  },
];

// ─── settings ───────────────────────────────────────────────────────────────

const settingsTools: ToolDef[] = [
  {
    name: "update_user_preferences",
    description:
      "Update Sir's user-level preferences in Sure — name, theme, locale, layout, default views, AI sidebar visibility. CRUCIAL: ai_enabled: false disables Sure's OWN in-app AI features — does NOT affect Alfred's API access. Hosting/provider Setting keys are intentionally NOT exposed. Backing: Rails-runner.",
    inputSchema: z.object({
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      theme: z.string().optional().describe("'light' | 'dark' | 'system'"),
      locale: z.string().optional(),
      ui_layout: z.string().optional(),
      show_sidebar: z.boolean().optional(),
      show_ai_sidebar: z.boolean().optional(),
      ai_enabled: z.boolean().optional(),
      rule_prompts_disabled: z.boolean().optional(),
      default_period: z.string().optional(),
      default_account_order: z.string().optional(),
      default_account_id: z.string().optional(),
      user_id: z.string().optional().describe("optional; defaults to family owner"),
    }),
    buildRequest: (args) => ({ method: "PATCH", path: "/api/v1/sure/user/preferences", body: args }),
  },
];

// ─── chats (Sure's internal AI chats) ───────────────────────────────────────

const chatTools: ToolDef[] = [
  {
    name: "list_sure_chats",
    description: "List Sure's INTERNAL AI chats (distinct from THIS conversation). Most of the time you don't need this — Alfred has its own conversation context. Backing: REST.",
    inputSchema: z.object({ ...Pagination }),
    buildRequest: (args) => ({ method: "GET", path: "/api/v1/sure/chats", query: passthroughQuery(args) }),
  },
  {
    name: "create_sure_chat",
    description: "Start a new Sure-internal AI chat. Use ONLY if Sir explicitly wants to seed a chat in Sure's own UI — for normal Q&A, you (Alfred) ARE the chat. Backing: REST.",
    inputSchema: z.object({
      title: z.string().optional(),
      model: z.string().optional(),
    }),
    buildRequest: (args) => ({ method: "POST", path: "/api/v1/sure/chats", body: { chat: args } }),
  },
  {
    name: "get_sure_chat",
    description: "Retrieve one Sure-internal chat with its messages. Backing: REST.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "GET", path: `/api/v1/sure/chats/${encodeURIComponent(id)}` }),
  },
  {
    name: "update_sure_chat",
    description: "Update a Sure-internal chat (rename, etc.). Backing: REST.",
    inputSchema: IdParam.extend({
      title: z.string().optional(),
    }),
    buildRequest: ({ id, ...body }) => ({ method: "PATCH", path: `/api/v1/sure/chats/${encodeURIComponent(id)}`, body: { chat: body } }),
  },
  {
    name: "delete_sure_chat",
    description: "Delete a Sure-internal chat and its messages. Backing: REST.",
    inputSchema: IdParam,
    buildRequest: ({ id }) => ({ method: "DELETE", path: `/api/v1/sure/chats/${encodeURIComponent(id)}` }),
  },
  {
    name: "post_sure_chat_message",
    description: "Post a message into a Sure-internal chat. Use only if Sir wants to drive Sure's in-app assistant from outside. Backing: REST.",
    inputSchema: z.object({
      chat_id: z.string().min(1),
      content: z.string(),
      role: z.string().optional().describe("'user' usually"),
    }),
    buildRequest: ({ chat_id, ...body }) => ({
      method: "POST",
      path: `/api/v1/sure/chats/${encodeURIComponent(chat_id)}/messages`,
      body: { message: body },
    }),
  },
  {
    name: "retry_sure_chat_message",
    description: "Re-run the last assistant turn in a Sure-internal chat. Backing: REST.",
    inputSchema: z.object({
      chat_id: z.string().min(1),
    }),
    buildRequest: ({ chat_id }) => ({
      method: "POST",
      path: `/api/v1/sure/chats/${encodeURIComponent(chat_id)}/messages/retry`,
    }),
  },
];

// ─── pipeline (clustering / bootstrap / sync) ───────────────────────────────

const pipelineTools: ToolDef[] = [
  {
    name: "trigger_sync",
    description:
      "Queue a family-wide sync across every connected provider — Lunchflow, Plaid, SimpleFIN, Sophtron, Enable Banking, Binance, Coinbase, CoinStats, etc. Runs ASYNCHRONOUSLY. Use this BEFORE generating a Money Day brief so figures are fresh. Once per session is plenty. Backing: REST.",
    inputSchema: z.object({}),
    buildRequest: () => ({ method: "POST", path: "/api/v1/sure/sync" }),
  },
  {
    name: "cluster_transactions",
    description:
      "Run alfred-learn's transaction clustering pipeline: TF-IDF alias merging on bank-feed name strings, behavioural co-occurrence for recurring patterns, and LLM category inference for residuals. Returns proposals only — review the top 20 by volume before applying via apply_cluster_proposals. Hard 9-minute server timeout (iterative + LLM can take 4-7 min on 3k txns). LLM cost: ~30k tokens (~$0.10–0.30) per full run. Backing: orchestrator.",
    inputSchema: z.object({
      similarity_threshold: z.number().optional().describe("default 0.4 — TF-IDF alias merging threshold"),
      min_group_size: z.number().int().optional().describe("default 2"),
      iterative: z.boolean().optional().describe("default true — multi-pass with LLM + behavioural"),
      target_coverage: z.number().optional().describe("default 0.80 — stop when ≥ 80% matched"),
      max_iterations: z.number().int().optional().describe("default 5"),
      use_llm: z.boolean().optional().describe("default true — disable for deterministic mode"),
      use_behavioural: z.boolean().optional().describe("default true"),
      llm_model: z.string().optional().describe("OpenClaw model id; default 'x-ai/grok-4.1-fast'"),
      llm_top_n: z.number().int().optional().describe("top-N largest groups to send to LLM per pass"),
      llm_min_group_size: z.number().int().optional(),
      available_categories: z.array(z.string()).optional().describe("tenant's actual categories — grounds the LLM prompt"),
      available_tags: z.array(z.string()).optional().describe("tenant's actual tags — grounds the LLM prompt"),
    }),
    buildRequest: (args) => ({ method: "POST", path: "/api/v1/sure/_cluster", body: args }),
  },
  {
    name: "apply_cluster_proposals",
    description:
      "Execute approved clustering proposals: ensures FamilyMerchant rows exist, creates Rules (transaction_name LIKE %keyword% → set merchant + category + tag), then fires apply_all_rules. Returns merchants_created / rules_created / failures. The built-in quality filter drops low-confidence transfer-role clusters by default. Use after cluster_transactions once Sir has reviewed. Backing: orchestrator.",
    inputSchema: z.object({
      proposals: z.array(z.object({
        canonical_name: z.string(),
        pattern_keyword: z.string().optional(),
        proposed_category: z.string(),
        proposed_tag: z.string().optional(),
        role: z.string().optional().describe("'merchant' | 'transfer' | etc."),
        txn_count: z.number().optional(),
        confidence: z.number().optional(),
        color: z.string().optional(),
      })).min(1),
      min_confidence: z.number().optional().describe("default 0.85"),
      drop_low_conf_transfer: z.boolean().optional().describe("default true"),
      low_conf_transfer_threshold: z.number().optional().describe("default 0.9"),
      drop_canonical_names: z.array(z.string()).optional().describe("explicit blacklist (case-insensitive)"),
    }),
    buildRequest: (args) => ({ method: "POST", path: "/api/v1/sure/_cluster/apply", body: args }),
  },
  {
    name: "bootstrap_sure_full",
    description:
      "End-to-end bootstrap on a fresh tenant: bootstrap_default_categories → cluster_transactions → apply_cluster_proposals in one call. Returns combined response. Total wall-clock on 3,000-transaction corpus: ~30 minutes. CRUCIAL: ctrl-api hard timeout is 25 minutes — much larger tenants need the three-step sequence invoked individually. For tenants where Sir wants to review proposals before applying, use the explicit two-step instead. Backing: orchestrator.",
    inputSchema: z.object({
      // forwarded to /_cluster
      similarity_threshold: z.number().optional(),
      min_group_size: z.number().int().optional(),
      iterative: z.boolean().optional(),
      target_coverage: z.number().optional(),
      max_iterations: z.number().int().optional(),
      use_llm: z.boolean().optional(),
      use_behavioural: z.boolean().optional(),
      llm_model: z.string().optional(),
      llm_top_n: z.number().int().optional(),
      llm_min_group_size: z.number().int().optional(),
      // forwarded to /_cluster/apply
      min_confidence: z.number().optional(),
      drop_low_conf_transfer: z.boolean().optional(),
      low_conf_transfer_threshold: z.number().optional(),
      drop_canonical_names: z.array(z.string()).optional(),
    }),
    buildRequest: (args) => ({ method: "POST", path: "/api/v1/sure/_bootstrap", body: args }),
  },
];

// ─── usage ──────────────────────────────────────────────────────────────────

const usageTools: ToolDef[] = [
  {
    name: "get_api_usage",
    description:
      "Get the current Sure API rate-limit window: rate_limit (tier, limit, current_count, remaining, reset_in_seconds, reset_at), api_key info. Use when a sequence of calls starts 429-ing. Backing: REST.",
    inputSchema: z.object({}),
    buildRequest: () => ({ method: "GET", path: "/api/v1/sure/usage" }),
  },
];

// ─── nuclear (destructive — require explicit Sir confirmation) ──────────────

const nuclearTools: ToolDef[] = [
  {
    name: "deactivate_api_user",
    description:
      "NUCLEAR — deactivates Sir's API user. After this, no further Sure API calls will work until Sir re-creates the user via the Sure web UI. NEVER call this without explicit, in-the-moment, unambiguous confirmation from Sir ('yes, I really want to disable my own API access'). NO UNDO via API. Backing: REST.",
    inputSchema: z.object({}),
    buildRequest: () => ({ method: "DELETE", path: "/api/v1/sure/users/me" }),
  },
  {
    name: "reset_all_data",
    description:
      "NUCLEAR — wipes ALL family data (every account, transaction, holding, valuation, rule, merchant, tag, chat, budget, share, invitation) and returns Sure to a fresh state. Equivalent to 'sudo rm -rf' on Sir's entire financial history. NEVER call this without explicit, in-the-moment, unambiguous confirmation from Sir ('yes, wipe everything'). Always recommend create_export first to grab a backup. NO UNDO. Backing: REST.",
    inputSchema: z.object({}),
    buildRequest: () => ({ method: "DELETE", path: "/api/v1/sure/users/reset" }),
  },
];

// ─── flat catalogue ─────────────────────────────────────────────────────────

export const ALL_TOOLS: ToolDef[] = [
  ...balanceSheetTools,
  ...accountTools,
  ...transactionTools,
  ...duplicateTools,
  ...categoryTools,
  ...merchantTools,
  ...tagTools,
  ...ruleTools,
  ...holdingTools,
  ...tradeTools,
  ...valuationTools,
  ...transferTools,
  ...recurringTools,
  ...shareTools,
  ...invitationTools,
  ...budgetTools,
  ...importTools,
  ...exportTools,
  ...settingsTools,
  ...chatTools,
  ...pipelineTools,
  ...usageTools,
  ...nuclearTools,
];
