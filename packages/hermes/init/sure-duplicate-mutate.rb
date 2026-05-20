# frozen_string_literal: true
#
# Duplicate-transaction handling via Rails runner for Sure.
#
# When Sure imports a "pending" transaction from a bank feed and a
# matching "posted" transaction shows up later, the model exposes
# Transaction#has_potential_duplicate? + #merge_with_duplicate! /
# #dismiss_duplicate_suggestion!. The web UI calls these from
# TransactionsController; this script lets ctrl-api do the same.
#
# Usage:
#   bin/rails runner sure-duplicate-mutate.rb <op> <payload-json-path>
#   op: merge | dismiss
#
# Source-of-truth references (we-promise/sure @ pinned SHA):
#   app/models/transaction.rb
#     #has_potential_duplicate?
#     #merge_with_duplicate!     — destroys the pending entry
#     #dismiss_duplicate_suggestion!

require_relative "sure-mutate-base"

op, data = SureMutate.parse_argv!
family   = SureMutate.family!

id = data["id"]
SureMutate.fail!("id required (Entry id of the pending transaction)") if id.to_s.strip.empty?

# id can be either Entry id or Transaction id; normalise to Transaction.
entry = Entry.joins(:account).where(accounts: { family_id: family.id }).find_by(id: id)
txn = if entry
        entry.entryable
      else
        Transaction.joins(entry: :account).where(accounts: { family_id: family.id }).find_by(id: id)
      end

SureMutate.not_found!("transaction", id) unless txn && txn.is_a?(Transaction)

unless txn.respond_to?(:has_potential_duplicate?) && txn.has_potential_duplicate?
  SureMutate.fail!("transaction #{id} has no potential duplicate suggestion", "validation_error")
end

case op
when "merge"
  begin
    ok = txn.merge_with_duplicate!
  rescue => e
    SureMutate.fail!("merge failed: #{e.class}: #{e.message}")
  end
  SureMutate.fail!("merge_with_duplicate! returned false", "merge_failed") unless ok
  SureMutate.success("merged" => id)

when "dismiss"
  begin
    ok = txn.dismiss_duplicate_suggestion!
  rescue => e
    SureMutate.fail!("dismiss failed: #{e.class}: #{e.message}")
  end
  SureMutate.fail!("dismiss_duplicate_suggestion! returned false", "dismiss_failed") unless ok
  SureMutate.success("dismissed" => id)

else
  SureMutate.fail!("unknown op '#{op}' — must be merge | dismiss")
end
