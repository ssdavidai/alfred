# frozen_string_literal: true
#
# Valuation mutations via Rails runner for the Sure self-hosted finance app.
#
# Sure has no dedicated `Valuation#destroy_with_sync!` method — the
# UI flow goes Entry#destroy (delegated_type :entryable, :dependent
# :destroy on Entry) and the account sync_later is handled by Entry's
# normal lifecycle. This script wraps that with a family + entry-type
# guard so callers can target a Valuation by its Entry id.
#
# Usage:
#   bin/rails runner sure-valuation-mutate.rb destroy <payload-json-path>
#
# Source-of-truth references (we-promise/sure @ pinned SHA):
#   app/models/entry.rb
#     delegated_type :entryable, types: Entryable::TYPES, dependent: :destroy
#     #valuation? helper

require_relative "sure-mutate-base"

op, data = SureMutate.parse_argv!
family   = SureMutate.family!

case op
when "destroy"
  id = data["id"]
  SureMutate.fail!("id required (Entry id of the valuation)") if id.to_s.strip.empty?

  entry = Entry.joins(:account).where(accounts: { family_id: family.id }).find_by(id: id)
  SureMutate.not_found!("valuation_entry", id) unless entry

  unless entry.entryable_type == "Valuation"
    SureMutate.fail!(
      "entry #{id} is not a Valuation (entryable_type=#{entry.entryable_type.inspect})",
      "validation_error"
    )
  end

  account_id = entry.account_id
  begin
    entry.destroy!
  rescue => e
    SureMutate.fail!("destroy failed: #{e.class}: #{e.message}")
  end

  account = family.accounts.find_by(id: account_id)
  account&.sync_later

  SureMutate.success("deleted" => id, "account_id" => account_id)

else
  SureMutate.fail!("unknown op '#{op}' — must be destroy")
end
