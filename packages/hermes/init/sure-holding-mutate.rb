# frozen_string_literal: true
#
# Holding mutations via Rails runner for the Sure self-hosted finance app.
#
# Sure has rich Holding-level operations (destroy, manual cost basis,
# unlock, remap to another security, reset to provider) but no public
# REST endpoints — they live as Active Record instance methods invoked
# from the holdings controller. This script gives Alfred programmatic
# access to that surface.
#
# Usage:
#   bin/rails runner sure-holding-mutate.rb <op> <payload-json-path>
#   op: destroy | set_manual_cost_basis | unlock_cost_basis |
#       remap_security | reset_security_to_provider
#
# Source-of-truth references (we-promise/sure @ pinned SHA):
#   app/models/holding.rb
#     #destroy_holding_and_entries!         — destroys all trade entries then holding, syncs account
#     #set_manual_cost_basis!(value)        — sets source="manual", locks
#     #unlock_cost_basis!                   — clears the lock so provider/calculated can take over
#     #remap_security!(new_security)        — moves holdings + trades to new security, merges on collision
#     #reset_security_to_provider!          — reverts a manual remap, only if provider_security_id present
#   app/models/security.rb                  — Security lookup (by id, ticker, or composite ticker:exchange)

require_relative "sure-mutate-base"

def find_holding(family, id)
  family.accounts
        .joins(:holdings)
        .where(holdings: { id: id })
        .first
        &.holdings
        &.find_by(id: id)
end

# Resolve a Security record from any of {id, ticker, ticker+exchange_operating_mic}.
def find_security(data)
  if data["security_id"].to_s.strip.length > 0
    return Security.find_by(id: data["security_id"])
  end
  if data["ticker"].to_s.strip.length > 0
    scope = Security.where("LOWER(ticker) = ?", data["ticker"].to_s.downcase.strip)
    if data["exchange_operating_mic"].to_s.strip.length > 0
      scope = scope.where("LOWER(exchange_operating_mic) = ?", data["exchange_operating_mic"].to_s.downcase.strip)
    end
    return scope.first
  end
  nil
end

def render_holding(h)
  {
    "id"                   => h.id,
    "account_id"           => h.account_id,
    "security_id"          => h.security_id,
    "date"                 => h.date.to_s,
    "qty"                  => h.qty.to_s,
    "amount"               => h.amount.to_s,
    "currency"             => h.currency,
    "cost_basis"           => h.try(:cost_basis)&.to_s,
    "cost_basis_source"    => h.try(:cost_basis_source),
    "cost_basis_locked"    => h.try(:cost_basis_locked),
    "security_locked"      => h.try(:security_locked),
    "provider_security_id" => h.try(:provider_security_id),
  }.compact
end

op, data = SureMutate.parse_argv!
family   = SureMutate.family!

id = data["id"]
SureMutate.fail!("id required") if id.to_s.strip.empty? && op != "destroy_for_account"
holding = find_holding(family, id)
SureMutate.not_found!("holding", id) unless holding

case op
when "destroy"
  begin
    holding.destroy_holding_and_entries!
  rescue => e
    SureMutate.fail!("destroy failed: #{e.class}: #{e.message}")
  end
  SureMutate.success("deleted" => id, "account_id" => holding.account_id)

when "set_manual_cost_basis"
  value = data["value"]
  SureMutate.fail!("value required (per-share cost basis)") if value.nil?
  begin
    holding.set_manual_cost_basis!(value)
  rescue ActiveRecord::RecordInvalid
    SureMutate.validation_error!(holding)
  rescue => e
    SureMutate.fail!("set_manual_cost_basis failed: #{e.class}: #{e.message}")
  end
  SureMutate.success("holding" => render_holding(holding.reload))

when "unlock_cost_basis"
  begin
    holding.unlock_cost_basis!
  rescue => e
    SureMutate.fail!("unlock_cost_basis failed: #{e.class}: #{e.message}")
  end
  SureMutate.success("holding" => render_holding(holding.reload))

when "remap_security"
  new_security = find_security(data)
  SureMutate.fail!(
    "could not resolve target security — supply security_id, or ticker (+ optional exchange_operating_mic)",
    "validation_error"
  ) unless new_security

  if new_security.id == holding.security_id
    SureMutate.fail!("target security is identical to current security", "validation_error")
  end

  begin
    holding.remap_security!(new_security)
  rescue ActiveRecord::RecordInvalid
    SureMutate.validation_error!(holding)
  rescue => e
    SureMutate.fail!("remap_security failed: #{e.class}: #{e.message}")
  end
  SureMutate.success(
    "holding"          => render_holding(holding.reload),
    "remapped_to"      => { "id" => new_security.id, "ticker" => new_security.ticker },
  )

when "reset_security_to_provider"
  unless holding.try(:provider_security_id).present?
    SureMutate.fail!("holding has no provider_security_id — nothing to reset", "validation_error")
  end
  begin
    holding.reset_security_to_provider!
  rescue => e
    SureMutate.fail!("reset_security_to_provider failed: #{e.class}: #{e.message}")
  end
  SureMutate.success("holding" => render_holding(holding.reload))

else
  SureMutate.fail!(
    "unknown op '#{op}' — must be destroy | set_manual_cost_basis | unlock_cost_basis | remap_security | reset_security_to_provider"
  )
end
