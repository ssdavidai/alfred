# frozen_string_literal: true
#
# Sure patch — expose per-account Lunchflow balance anchor state (#318)
#
# WHY
# ---
# Alfred's finance surface consumed Sure balances without freshness provenance.
# When the Lunchflow provider token expires, Sure falls back to cached balances
# and logs "No current balance anchor found … Using cached balance instead".
# ctrl-api had no signal to propagate this to the principal — figures looked
# current while relying on stale cached values.
#
# WHY NOT USE REST-VISIBLE TIMESTAMPS
# ------------------------------------
# Sure's /api/v1/accounts payload carries exactly two timestamps per account
# (created_at, updated_at) and no balance-specific date. Measured fleet-wide
# against live data:
#
#   provider-backed accounts (linked via account_providers):         13
#   of those, has_provider_anchor = false (current_balance IS NULL): 12
#   of those, max(balances.date) was today-or-yesterday:              9
#
# Nine of twelve genuinely stale accounts would report as fresh via
# max(balances.date) because Sure's cached-fallback write path is itself a
# write that advances that date. Reporting confident freshness on stale data
# is worse than reporting nothing — it replaces silent staleness with a
# confident lie. The only accurate signal is lunchflow_accounts.current_balance
# IS NULL.
#
# ACCOUNT LINKAGE
# ---------------
# lunchflow_accounts.account_id is the provider's external id (5 chars on the
# measured tenant), NOT Sure's accounts.id UUID (36 chars). They cannot be
# joined directly. The correct traversal is via account_providers:
#
#   LunchflowAccount
#     has_one :account_provider, as: :provider  (provider_type = 'LunchflowAccount')
#     has_one :account, through: :account_provider
#
# In SQL: account_providers ap ON ap.provider_id = la.id AND
#         ap.provider_type = 'LunchflowAccount' JOIN accounts a ON a.id = ap.account_id
#
# Measured: 13 of 16 lunchflow rows resolve to a Sure account via this path.
# The 3 unlinked rows are omitted from accounts[] — do not guess a match for
# them. An unlinked provider row is not an account. They are counted separately
# under unlinked_provider_accounts.
#
# THE PATCH
# ---------
# Adds GET /api/v1/alfred/balance_anchor_state — a read-only endpoint that
# exposes per-account anchor state drawn directly from the vendor-internal
# lunchflow_accounts table Sure's REST API never surfaces.
#
# Response shape:
#   { "accounts": [
#       { "account_id": "<36-char UUID matching accounts.id>",
#         "has_provider_anchor": true|false|null,
#         "provider_status": "…"|null,
#         "provider_observed_at": "ISO8601"|null }
#     ],
#     "unlinked_provider_accounts": <integer>,
#     "generated_at": "ISO8601" }
#
# has_provider_anchor semantics:
#   true  = current_balance IS NOT NULL   (provider delivered data this cycle)
#   false = current_balance IS NULL       (Sure is using a cached fallback)
#   null  = column absent or unreadable   (consumer MUST treat as unknown, not fresh)
#
# Authentication: X-Api-Key header — the same SURE_API_KEY credential used by
# every other Sure API endpoint. No new credential introduced.
#
# VERIFY: account_id values in accounts[] must be 36-char UUIDs matching
# accounts.id. If any returned id is shorter (e.g. 5 chars), the association
# traversal is broken and the results must not be used for freshness attribution.
# Check: curl … | jq '.accounts[].account_id | length' — all must be 36.
#
# WHY AN INITIALIZER, NOT A FILE OVERLAY
# ----------------------------------------
# Same rationale as preserve_lunchflow_currency.rb: a file overlay pins us to
# one upstream revision and silently reverts upstream fixes on upgrade. An
# initializer composes with whatever the upstream file becomes. If
# LunchflowAccount or its columns are absent (upstream schema change), the
# endpoint degrades gracefully rather than crashing sure-web on boot.
#
# REMOVE THIS when Sure exposes balance anchor state via its own REST API.
# Check on upgrade: if GET /api/v1/accounts includes a freshness or anchor
# field, this patch is redundant. Remove the initializer and its mount.

Rails.application.config.to_prepare do
  next if defined?(::AlfredBalanceAnchorStateController)

  class ::AlfredBalanceAnchorStateController < ActionController::API
    ALFRED_TAG = "[alfred #318]"

    def show
      provided = request.headers["X-Api-Key"].to_s.strip
      expected = ENV["SURE_API_KEY"].to_s.strip
      if expected.empty? || !ActiveSupport::SecurityUtils.secure_compare(provided, expected)
        render json: { error: "Unauthorized" }, status: :unauthorized
        return
      end

      linked, unlinked_count = anchor_state_partition
      render json: {
        accounts: linked,
        unlinked_provider_accounts: unlinked_count,
        generated_at: Time.now.utc.iso8601
      }
    end

    private

    # Partition all LunchflowAccount rows into linked (have a Sure accounts.id)
    # and unlinked (no account_providers row). Returns [linked_rows, unlinked_count].
    # Unlinked rows are NOT included in accounts[] — never invent a match.
    def anchor_state_partition
      unless defined?(::LunchflowAccount)
        Rails.logger.warn("#{ALFRED_TAG} LunchflowAccount not defined — returning empty anchor state")
        return [[], 0]
      end

      linked = []
      unlinked = 0
      ::LunchflowAccount.all.each do |acct|
        sure_id = resolve_sure_account_id(acct)
        if sure_id.nil?
          unlinked += 1
          next
        end
        linked << anchor_row(sure_id, acct)
      end
      [linked, unlinked]
    rescue => e
      Rails.logger.error("#{ALFRED_TAG} error reading lunchflow_accounts: #{e.message}")
      [[], 0]
    end

    # Traverse lunchflow_account → account_provider (polymorphic) → account.id.
    # Returns the 36-char Sure accounts.id UUID, or nil for unlinked rows.
    # Never returns lunchflow_accounts.account_id (the provider's external short id).
    def resolve_sure_account_id(acct)
      return nil unless acct.respond_to?(:account)
      acct.account&.id
    rescue => e
      Rails.logger.warn("#{ALFRED_TAG} account association error for provider row #{acct.try(:id)}: #{e.message}")
      nil
    end

    def anchor_row(sure_account_id, acct)
      {
        account_id:           sure_account_id,
        has_provider_anchor:  anchor_flag(acct),
        provider_status:      provider_status(acct),
        provider_observed_at: safe_iso8601(acct, :updated_at)
      }
    end

    # true  = current_balance IS NOT NULL (provider anchor present)
    # false = current_balance IS NULL     (cached fallback path)
    # nil   = column absent or error (consumer MUST NOT infer fresh)
    def anchor_flag(acct)
      return nil unless acct.respond_to?(:current_balance)
      !acct.current_balance.nil?
    rescue => e
      Rails.logger.warn("#{ALFRED_TAG} anchor_flag error for #{acct.try(:id)}: #{e.message}")
      nil
    end

    def provider_status(acct)
      return nil unless acct.respond_to?(:raw_payload)
      payload = acct.raw_payload
      return nil unless payload.is_a?(Hash)
      payload["status"]
    rescue => e
      Rails.logger.warn("#{ALFRED_TAG} provider_status error for #{acct.try(:id)}: #{e.message}")
      nil
    end

    def safe_iso8601(acct, attr)
      return nil unless acct.respond_to?(attr)
      val = acct.public_send(attr)
      val&.utc&.iso8601
    rescue
      nil
    end
  end
end

Rails.application.routes.draw do
  get "/api/v1/alfred/balance_anchor_state",
      to: "alfred_balance_anchor_state#show"
end
