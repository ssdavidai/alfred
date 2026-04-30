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
  account_attrs     = data.except("accountable_type", "accountable_attributes")

  FAIL.call("accountable_type required (one of: #{Accountable::TYPES.join(', ')})") if accountable_type.to_s.strip.empty?

  unless Accountable::TYPES.include?(accountable_type)
    FAIL.call("invalid accountable_type '#{accountable_type}' — must be one of: #{Accountable::TYPES.join(', ')}")
  end

  klass = accountable_type.constantize
  accountable = klass.new(accountable_attrs)

  account = family.accounts.new(account_attrs)
  account.accountable = accountable

  begin
    Account.transaction do
      account.save!
    end
  rescue ActiveRecord::RecordInvalid => e
    FAIL.call("validation failed: #{account.errors.full_messages.join('; ')}", "validation_error")
  rescue => e
    FAIL.call("create failed: #{e.class}: #{e.message}")
  end

  SUCCESS.call("account" => render_account(account))

when "update"
  id = data["id"]
  FAIL.call("id required for update") if id.to_s.strip.empty?
  account = family.accounts.find_by(id: id)
  FAIL.call("account not found: #{id}", "not_found") unless account

  account_attrs     = data.except("id", "accountable_attributes")
  accountable_attrs = data["accountable_attributes"]

  begin
    Account.transaction do
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

  SUCCESS.call("account" => render_account(account))

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
