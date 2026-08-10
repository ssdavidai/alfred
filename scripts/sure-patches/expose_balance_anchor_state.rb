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
#   stale accounts (lunchflow_accounts.current_balance IS NULL):   6
#   of those, max(balances.date) was today-or-yesterday:           4
#
# Two-thirds of stale accounts would report as fresh via max(balances.date)
# because Sure's cached-fallback write path is itself a write that advances
# that date. Reporting confident freshness on stale data is worse than
# reporting nothing — it replaces silent staleness with a confident lie.
# The only accurate signal is lunchflow_accounts.current_balance IS NULL.
#
# THE PATCH
# ---------
# Adds GET /api/v1/alfred/balance_anchor_state — a read-only endpoint that
# exposes per-account anchor state drawn directly from the vendor-internal
# lunchflow_accounts table Sure's REST API never surfaces.
#
# Response shape:
#   { "accounts": [
#       { "account_id": "…",
#         "has_provider_anchor": true|false|null,
#         "provider_status": "…"|null,
#         "provider_observed_at": "ISO8601"|null }
#     ],
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

      render json: {
        accounts: anchor_state_rows,
        generated_at: Time.now.utc.iso8601
      }
    end

    private

    def anchor_state_rows
      unless defined?(::LunchflowAccount)
        Rails.logger.warn("#{ALFRED_TAG} LunchflowAccount not defined — returning empty anchor state")
        return []
      end

      ::LunchflowAccount.all.map { |acct| anchor_row(acct) }
    rescue => e
      Rails.logger.error("#{ALFRED_TAG} error reading lunchflow_accounts: #{e.message}")
      []
    end

    def anchor_row(acct)
      {
        account_id:           safe_attr(acct, :account_id),
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
      Rails.logger.warn("#{ALFRED_TAG} anchor_flag error for #{acct.try(:account_id)}: #{e.message}")
      nil
    end

    def provider_status(acct)
      return nil unless acct.respond_to?(:raw_payload)
      payload = acct.raw_payload
      return nil unless payload.is_a?(Hash)
      payload["status"]
    rescue => e
      Rails.logger.warn("#{ALFRED_TAG} provider_status error for #{acct.try(:account_id)}: #{e.message}")
      nil
    end

    def safe_attr(acct, attr)
      acct.respond_to?(attr) ? acct.public_send(attr) : nil
    rescue
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
