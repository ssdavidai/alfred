# frozen_string_literal: true
#
# Transfer CRUD via Rails runner for the Sure self-hosted finance app.
#
# Sure's public REST API has no /transfers endpoint and no `transfer`
# field on the transactions controller — paired-transaction transfers
# (loan payments, inter-account moves, credit-card payments) are web-UI
# only. This script gives ctrl-api a programmatic path that mirrors
# Sure's web TransfersController + Transfer::Creator service.
#
# Usage:
#   bin/rails runner sure-transfer-mutate.rb <op> <payload-json-path>
#   op: create | confirm | reject | destroy | match
#
# Source-of-truth references (we-promise/sure @ main):
#   app/models/transfer.rb               — Transfer model + #confirm! / #reject! / #destroy!
#   app/models/transfer/creator.rb       — Transfer::Creator service
#   app/controllers/transfers_controller.rb — web equivalent
#   app/controllers/transfer_matches_controller.rb — match flow

require_relative "sure-mutate-base"

# ----------- helpers -----------

def find_transfer(family, id)
  Transfer.joins(inflow_transaction: { entry: :account })
          .where(accounts: { family_id: family.id })
          .find_by(id: id)
end

def render_transfer(t)
  return nil unless t
  {
    "id"                     => t.id,
    "status"                 => t.status,
    "source_account_id"      => t.from_account&.id,
    "destination_account_id" => t.to_account&.id,
    "amount"                 => t.amount_abs&.amount&.to_s,
    "currency"               => t.amount_abs&.currency&.iso_code,
    "date"                   => t.date&.to_s,
    "name"                   => t.name,
    "outflow_transaction_id" => t.outflow_transaction&.id,
    "inflow_transaction_id"  => t.inflow_transaction&.id,
  }.compact
end

# ----------- dispatch -----------

op, data = SureMutate.parse_argv!
family   = SureMutate.family!

case op
when "create"
  source_id     = data["source_account_id"]
  dest_id       = data["destination_account_id"]
  amount        = data["amount"]
  date          = data["date"]
  exchange_rate = data["exchange_rate"]

  SureMutate.fail!("source_account_id required")      if source_id.to_s.strip.empty?
  SureMutate.fail!("destination_account_id required") if dest_id.to_s.strip.empty?
  SureMutate.fail!("amount required")                 if amount.to_s.strip.empty?
  SureMutate.fail!("date required")                   if date.to_s.strip.empty?

  begin
    parsed_date = Date.parse(date.to_s)
  rescue ArgumentError
    SureMutate.fail!("invalid date '#{date}'", "validation_error")
  end

  transfer =
    begin
      Transfer::Creator.new(
        family:                 family,
        source_account_id:      source_id,
        destination_account_id: dest_id,
        date:                   parsed_date,
        amount:                 amount,
        exchange_rate:          exchange_rate.presence,
      ).create
    rescue ActiveRecord::RecordNotFound => e
      SureMutate.fail!("account not found: #{e.message}", "not_found")
    rescue ArgumentError => e
      SureMutate.fail!("invalid argument: #{e.message}", "validation_error")
    rescue Money::ConversionError => e
      SureMutate.fail!("exchange rate unavailable: #{e.message}", "validation_error")
    rescue => e
      SureMutate.fail!("create failed: #{e.class}: #{e.message}")
    end

  unless transfer&.persisted?
    SureMutate.validation_error!(transfer)
  end

  SureMutate.success("transfer" => render_transfer(transfer))

when "confirm"
  id = data["id"]
  SureMutate.fail!("id required for confirm") if id.to_s.strip.empty?

  transfer = find_transfer(family, id)
  SureMutate.not_found!("transfer", id) unless transfer

  begin
    transfer.confirm!
  rescue ActiveRecord::RecordInvalid
    SureMutate.validation_error!(transfer)
  rescue => e
    SureMutate.fail!("confirm failed: #{e.class}: #{e.message}")
  end

  SureMutate.success("transfer" => render_transfer(transfer.reload))

when "reject"
  id = data["id"]
  SureMutate.fail!("id required for reject") if id.to_s.strip.empty?

  transfer = find_transfer(family, id)
  SureMutate.not_found!("transfer", id) unless transfer

  begin
    transfer.reject!
  rescue => e
    SureMutate.fail!("reject failed: #{e.class}: #{e.message}")
  end

  SureMutate.success("rejected" => id)

when "destroy"
  id = data["id"]
  SureMutate.fail!("id required for destroy") if id.to_s.strip.empty?

  transfer = find_transfer(family, id)
  SureMutate.not_found!("transfer", id) unless transfer

  begin
    transfer.destroy!
  rescue => e
    SureMutate.fail!("destroy failed: #{e.class}: #{e.message}")
  end

  SureMutate.success("deleted" => id)

when "match"
  inflow_id  = data["inflow_transaction_id"]
  outflow_id = data["outflow_transaction_id"]
  SureMutate.fail!("inflow_transaction_id required")  if inflow_id.to_s.strip.empty?
  SureMutate.fail!("outflow_transaction_id required") if outflow_id.to_s.strip.empty?

  family_account_ids = family.accounts.pluck(:id)
  inflow_txn = Transaction.joins(:entry)
                          .where(entries: { account_id: family_account_ids })
                          .find_by(id: inflow_id)
  SureMutate.not_found!("inflow_transaction", inflow_id) unless inflow_txn
  outflow_txn = Transaction.joins(:entry)
                           .where(entries: { account_id: family_account_ids })
                           .find_by(id: outflow_id)
  SureMutate.not_found!("outflow_transaction", outflow_id) unless outflow_txn

  transfer = Transfer.find_or_initialize_by(
    inflow_transaction_id:  inflow_id,
    outflow_transaction_id: outflow_id,
  )
  transfer.status ||= "confirmed"

  begin
    transfer.save!
  rescue ActiveRecord::RecordInvalid
    SureMutate.validation_error!(transfer)
  rescue => e
    SureMutate.fail!("match failed: #{e.class}: #{e.message}")
  end

  SureMutate.success("transfer" => render_transfer(transfer))

else
  SureMutate.fail!("unknown op '#{op}' — must be create | confirm | reject | destroy | match")
end
