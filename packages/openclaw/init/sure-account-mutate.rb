# frozen_string_literal: true
#
# Account CRUD via Rails runner for the Sure self-hosted finance app.
#
# Sure's public REST API (api/v1/accounts_controller.rb) only exposes
# `index`. The web controller has full CRUD but requires a browser session
# cookie that ctrl-api can't easily produce. To give Alfred parity with
# what Sir can do in the Sure UI, we call Sure's ActiveRecord models
# directly — same code path as the web controller, just without the HTTP
# layer.
#
# Usage:
#   bin/rails runner sure-account-mutate.rb <op> <payload-json-path>
#   op: create | update | delete
#
# stdout: a single JSON line on success: {"ok": true, ...}
# stdout: a single JSON line on failure: {"ok": false, "error": "..."}
# Always exits 0 — the caller distinguishes by parsing the JSON. (Rails
# runner's own non-zero exits are reserved for crashes that produce no
# JSON — caller treats those as 502.)

require "json"

EXIT_OK    = 0
SUCCESS    = ->(payload) {
  puts JSON.generate({ "ok" => true }.merge(payload))
  exit EXIT_OK
}
FAIL       = ->(message, status = "error") {
  puts JSON.generate({ "ok" => false, "error" => message, "status" => status })
  exit EXIT_OK
}

op            = ARGV[0]
payload_path  = ARGV[1]

FAIL.call("op argument required (create|update|delete)") if op.to_s.strip.empty?
FAIL.call("payload path argument required")              if payload_path.to_s.strip.empty?
FAIL.call("payload file missing: #{payload_path}")       unless File.exist?(payload_path)

begin
  data = JSON.parse(File.read(payload_path))
rescue JSON::ParserError => e
  FAIL.call("invalid JSON payload: #{e.message}")
end

# Single-tenant assumption: one Family per tenant. If/when Sure grows
# multi-family support inside one instance, accept family_id in payload.
family = Family.first
FAIL.call("no Family record found — Sure has not been bootstrapped") unless family

# Render the standard fields we expose back to the caller. Done as a
# helper because we re-use it across create / update.
def render_account(account)
  {
    "id"               => account.id,
    "name"             => account.name,
    "balance"          => account.balance.to_s,
    "currency"         => account.currency,
    "classification"   => account.classification,
    "accountable_type" => account.accountable_type,
    "subtype"          => account.try(:subtype),
    "status"           => account.status
  }
end

case op
when "create"
  accountable_type  = data["accountable_type"]
  accountable_attrs = data["accountable_attributes"] || {}
  # `subtype` belongs to the accountable, not the Account. Hoist it
  # into accountable_attributes so create_and_sync wires it correctly.
  if data.key?("subtype")
    accountable_attrs["subtype"] = data["subtype"] unless accountable_attrs.key?("subtype")
  end
  # opening_balance_date defaults to two years ago, matching what
  # AccountableResource#create does in the upstream web controller. The
  # caller may override via opening_balance_date in ISO yyyy-mm-dd form.
  opening_balance_date =
    begin
      d = data["opening_balance_date"]
      d.present? ? Date.parse(d) : (Date.today - 2.years)
    rescue ArgumentError
      Date.today - 2.years
    end
  account_attrs = data.except(
    "accountable_type", "accountable_attributes", "subtype", "opening_balance_date"
  )

  FAIL.call("accountable_type required (one of: #{Accountable::TYPES.join(', ')})") if accountable_type.to_s.strip.empty?

  unless Accountable::TYPES.include?(accountable_type)
    FAIL.call("invalid accountable_type '#{accountable_type}' — must be one of: #{Accountable::TYPES.join(', ')}")
  end

  # Mirror the web controller exactly: build the accountable into the
  # account params under accountable_attributes, then call
  # create_and_sync. This is what the LoansController inherits via
  # AccountableResource#create — it creates the Account, the
  # accountable subtype record, AND the initial Valuation entry that
  # actually drives Sure's balance + net-worth calculations. Plain
  # accounts.new + save! produces an Account with .balance == 0 because
  # no valuation gets seeded.
  create_params = account_attrs.merge(
    "accountable_type"       => accountable_type,
    "accountable_attributes" => accountable_attrs,
  )

  account = nil
  begin
    Account.transaction do
      account = family.accounts.create_and_sync(
        create_params,
        opening_balance_date: opening_balance_date,
      )
      account.lock_saved_attributes! if account.respond_to?(:lock_saved_attributes!)
    end
  rescue ActiveRecord::RecordInvalid => e
    msg = account ? account.errors.full_messages.join('; ') : e.message
    FAIL.call("validation failed: #{msg}", "validation_error")
  rescue => e
    FAIL.call("create failed: #{e.class}: #{e.message}")
  end

  SUCCESS.call("account" => render_account(account))

when "update"
  id = data["id"]
  FAIL.call("id required for update") if id.to_s.strip.empty?
  account = family.accounts.find_by(id: id)
  FAIL.call("account not found: #{id}", "not_found") unless account

  # Balance updates need set_current_balance — it creates a new Valuation
  # entry so the change is recorded historically. Direct .update on
  # Account#balance only writes the denormalized cache and gets
  # overwritten on the next sync.
  new_balance = data["balance"]
  account_attrs = data.except("id", "balance", "accountable_attributes", "subtype")
  if data.key?("subtype")
    accountable_attrs = (data["accountable_attributes"] || {}).dup
    accountable_attrs["subtype"] = data["subtype"] unless accountable_attrs.key?("subtype")
  else
    accountable_attrs = data["accountable_attributes"]
  end

  begin
    Account.transaction do
      if new_balance.present? && new_balance.to_d != account.balance
        result = account.set_current_balance(new_balance.to_d)
        unless result.success?
          FAIL.call("balance update failed: #{result.error_message}", "validation_error")
        end
      end
      account.update!(account_attrs) if account_attrs.any?
      if accountable_attrs.is_a?(Hash) && accountable_attrs.any? && account.accountable
        account.accountable.update!(accountable_attrs)
      end
    end
  rescue ActiveRecord::RecordInvalid => e
    FAIL.call("validation failed: #{account.errors.full_messages.join('; ')}", "validation_error")
  rescue => e
    FAIL.call("update failed: #{e.class}: #{e.message}")
  end

  SUCCESS.call("account" => render_account(account.reload))

when "delete"
  id = data["id"]
  FAIL.call("id required for delete") if id.to_s.strip.empty?
  account = family.accounts.find_by(id: id)
  FAIL.call("account not found: #{id}", "not_found") unless account

  if account.respond_to?(:linked?) && account.linked?
    FAIL.call("cannot delete a linked (provider-synced) account; unlink first via the Sure UI", "linked_account")
  end

  begin
    if account.respond_to?(:destroy_later)
      account.destroy_later  # soft-delete: status=pending_deletion, async hard-delete
    else
      account.destroy!
    end
  rescue => e
    FAIL.call("delete failed: #{e.class}: #{e.message}")
  end

  SUCCESS.call("deleted" => id)

else
  FAIL.call("unknown op '#{op}' — must be create | update | delete")
end
