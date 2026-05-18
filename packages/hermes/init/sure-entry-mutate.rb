# frozen_string_literal: true
#
# Transaction split/unsplit + bulk update/delete via Rails runner.
#
# Sure's public REST API has no /transactions/:id/split, no
# /transactions/:id/unsplit, and no bulk endpoints. The web UI exposes
# all four through dedicated controllers; this script mirrors them via
# the underlying Entry model methods.
#
# Usage:
#   bin/rails runner sure-entry-mutate.rb <op> <payload-json-path>
#   op: split | unsplit | bulk_update | bulk_delete
#
# Source-of-truth references (we-promise/sure @ main):
#   app/models/entry.rb#split! / #unsplit!         — split/unsplit
#   app/models/entry.rb (Entry::Bulkable concern)  — bulk_update!
#   app/controllers/splits_controller.rb           — web split flow
#   app/controllers/transactions/bulk_updates_controller.rb
#   app/controllers/transactions/bulk_deletions_controller.rb

require_relative "sure-mutate-base"

# ----------- helpers -----------

def find_transaction(family, id)
  family_account_ids = family.accounts.pluck(:id)
  Transaction.joins(:entry)
             .where(entries: { account_id: family_account_ids })
             .find_by(id: id)
end

def render_entry(entry)
  return nil unless entry
  txn = entry.entryable_type == "Transaction" ? entry.entryable : nil
  {
    "transaction_id" => txn&.id,
    "entry_id"       => entry.id,
    "name"           => entry.name,
    "amount"         => entry.amount.to_s,
    "currency"       => entry.currency,
    "date"           => entry.date.to_s,
    "account_id"     => entry.account_id,
    "category_id"    => txn&.category_id,
    "merchant_id"    => txn&.merchant_id,
    "kind"           => txn&.kind,
    "excluded"       => entry.excluded,
  }.compact
end

# ----------- dispatch -----------

op, data = SureMutate.parse_argv!
family   = SureMutate.family!

case op
when "split"
  txn_id = data["id"]
  splits = data["splits"]
  SureMutate.fail!("id required for split") if txn_id.to_s.strip.empty?
  SureMutate.fail!("splits array required") unless splits.is_a?(Array) && splits.any?

  txn = find_transaction(family, txn_id)
  SureMutate.not_found!("transaction", txn_id) unless txn

  entry = txn.entry
  SureMutate.fail!("transaction is already a split child", "validation_error") if entry.split_child?

  begin
    Entry.transaction do
      entry.split!(splits)
    end
  rescue ActiveRecord::RecordInvalid
    SureMutate.validation_error!(entry)
  rescue ArgumentError => e
    SureMutate.fail!("split rejected: #{e.message}", "validation_error")
  rescue => e
    SureMutate.fail!("split failed: #{e.class}: #{e.message}")
  end

  children = entry.split_children.includes(:entryable).map { |child| render_entry(child) }
  SureMutate.success("parent" => render_entry(entry.reload), "children" => children)

when "unsplit"
  txn_id = data["id"]
  SureMutate.fail!("id required for unsplit") if txn_id.to_s.strip.empty?

  txn = find_transaction(family, txn_id)
  SureMutate.not_found!("transaction", txn_id) unless txn

  entry = txn.entry
  SureMutate.fail!("transaction is not a split parent", "validation_error") unless entry.split_parent?

  begin
    Entry.transaction do
      entry.unsplit!
    end
  rescue => e
    SureMutate.fail!("unsplit failed: #{e.class}: #{e.message}")
  end

  SureMutate.success("entry" => render_entry(entry.reload))

when "bulk_update"
  txn_ids = data["transaction_ids"]
  attrs   = data["attributes"] || {}
  SureMutate.fail!("transaction_ids array required") unless txn_ids.is_a?(Array) && txn_ids.any?

  family_account_ids = family.accounts.pluck(:id)
  entries = Entry.joins("INNER JOIN transactions ON transactions.id = entries.entryable_id AND entries.entryable_type = 'Transaction'")
                 .where(account_id: family_account_ids, transactions: { id: txn_ids })

  found_ids = entries.joins(:entryable).pluck("transactions.id")
  missing = txn_ids - found_ids
  SureMutate.not_found!("transactions", missing.join(",")) if missing.any?

  permitted_keys = %w[date notes name category_id merchant_id]
  bulk_params = attrs.slice(*permitted_keys)
  update_tags = attrs.key?("tag_ids")
  bulk_params["tag_ids"] = attrs["tag_ids"] if update_tags

  begin
    Entry.transaction do
      entries.bulk_update!(bulk_params, update_tags: update_tags)
    end
  rescue ActiveRecord::RecordInvalid => e
    SureMutate.fail!("bulk_update validation failed: #{e.message}", "validation_error")
  rescue ArgumentError => e
    SureMutate.fail!("bulk_update rejected: #{e.message}", "validation_error")
  rescue => e
    SureMutate.fail!("bulk_update failed: #{e.class}: #{e.message}")
  end

  SureMutate.success("updated_count" => entries.count, "transaction_ids" => found_ids)

when "bulk_delete"
  txn_ids = data["transaction_ids"]
  SureMutate.fail!("transaction_ids array required") unless txn_ids.is_a?(Array) && txn_ids.any?

  family_account_ids = family.accounts.pluck(:id)
  entries = Entry.where(
    account_id: family_account_ids,
    entryable_type: "Transaction",
    entryable_id: txn_ids,
  )

  found_ids = entries.pluck(:entryable_id)
  missing = txn_ids - found_ids
  SureMutate.not_found!("transactions", missing.join(",")) if missing.any?

  # Reject split children — they must be deleted via the parent entry
  if entries.any? { |e| e.split_child? }
    SureMutate.fail!("split-child transactions cannot be deleted individually; delete the parent", "validation_error")
  end

  affected_account_ids = entries.pluck(:account_id).uniq

  begin
    Entry.transaction do
      entries.destroy_all
    end
  rescue => e
    SureMutate.fail!("bulk_delete failed: #{e.class}: #{e.message}")
  end

  # Re-sync each affected account so balance materializer picks up the deletes.
  Account.where(id: affected_account_ids).find_each(&:sync_later)

  SureMutate.success("deleted_count" => found_ids.size, "transaction_ids" => found_ids)

else
  SureMutate.fail!("unknown op '#{op}' — must be split | unsplit | bulk_update | bulk_delete")
end
