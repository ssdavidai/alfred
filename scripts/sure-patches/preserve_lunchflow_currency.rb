# Sure patch — stop Lunchflow resetting a known account currency to USD (#340)
#
# WHY
# ---
# Lunchflow/GoCardless does not send a `currency` for these accounts. Sure's
# `LunchflowAccount#upsert_lunchflow_snapshot!` therefore does:
#
#     currency: parse_currency(snapshot[:currency]) || "USD"
#
# That runs on EVERY sync for EVERY account, so a hand-corrected currency is
# overwritten on the next poll. Observed live: an account correctly set to HUF
# reverted to USD mid-investigation. Seven accounts holding real money were
# therefore valued as dollars and displayed as zero — a seven-figure HUF
# balance among them.
#
# THE PATCH
# ---------
# One rule: never overwrite a currency we already have with a guess.
#
#   payload currency (if valid)  ->  use it
#   else existing stored value   ->  keep it
#   else                         ->  "USD" (unchanged for genuinely new records)
#
# So a currency set once — by hand, or by the operator UI — now survives every
# subsequent sync, and the upstream default still applies to accounts nobody
# has classified.
#
# WHY AN INITIALIZER, NOT A FILE OVERLAY
# --------------------------------------
# Sure is self-hosted, so patching is legitimate. But bind-mounting a modified
# copy of `app/models/lunchflow_account.rb` would pin us to one upstream
# revision: any Sure update changes that file and our copy silently reverts
# their fixes. A prepended module touches one method and composes with whatever
# the upstream file becomes.
#
# It also fails loudly rather than silently: if upstream renames or removes
# `upsert_lunchflow_snapshot!`, the guard below logs and skips instead of
# monkey-patching a method that no longer means what we think.
#
# REMOVE THIS when Sure accepts a currency from the account record or Lunchflow
# starts sending one. Check on upgrade.

Rails.application.config.to_prepare do
  unless defined?(::LunchflowAccount)
    Rails.logger.warn("[alfred #340] LunchflowAccount not defined — currency patch skipped")
    next
  end

  unless ::LunchflowAccount.method_defined?(:upsert_lunchflow_snapshot!)
    Rails.logger.warn(
      "[alfred #340] LunchflowAccount#upsert_lunchflow_snapshot! is gone — " \
      "currency patch skipped. Upstream changed; re-check whether #340 still applies."
    )
    next
  end

  module AlfredPreserveLunchflowCurrency
    def upsert_lunchflow_snapshot!(snapshot)
      known = currency.presence
      super
      # `super` re-derives currency from the payload and falls back to "USD".
      # If it landed on USD only because the payload was silent, and we already
      # knew better, put the known value back.
      payload_ccy = snapshot.is_a?(Hash) ? (snapshot[:currency] || snapshot["currency"]) : nil
      if known.present? && payload_ccy.blank? && currency != known
        Rails.logger.info(
          "[alfred #340] preserving currency #{known} for lunchflow account " \
          "#{account_id} (payload sent none; upstream default would have been #{currency})"
        )
        self.currency = known
        save! if persisted?
      end
    end
  end

  ::LunchflowAccount.prepend(AlfredPreserveLunchflowCurrency)
  Rails.logger.info("[alfred #340] Lunchflow currency-preservation patch loaded")
end
