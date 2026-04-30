# frozen_string_literal: true
#
# Recurring transactions via Rails runner for the Sure self-hosted finance app.
#
# Sure detects recurring patterns (rent, utilities, subscriptions, payroll)
# and tracks each as a `RecurringTransaction`. The web UI exposes a
# Settings → Recurring panel for "Identify now", "Cleanup stale",
# "Mark active/inactive". This script gives Alfred programmatic access.
#
# Usage:
#   bin/rails runner sure-recurring-mutate.rb <op> <payload-json-path>
#   op: identify | cleanup_stale | mark_active | mark_inactive
#
# Source-of-truth references (we-promise/sure @ pinned SHA):
#   app/models/recurring_transaction.rb
#     .identify_patterns_for!(family)         — synchronous, returns Identifier result
#     .cleanup_stale_for(family)              — synchronous, returns Cleaner result
#     #mark_active!  / #mark_inactive!        — toggles status

require_relative "sure-mutate-base"

def render_recurring(r)
  {
    "id"                  => r.id,
    "merchant_id"         => r.merchant_id,
    "name"                => r.try(:name),
    "currency"            => r.try(:currency),
    "status"              => r.try(:status),
    "manual"              => r.try(:manual),
    "expected_day"        => r.try(:expected_day),
    "last_occurrence_date" => r.try(:last_occurrence_date)&.to_s,
    "next_expected_date"  => r.try(:next_expected_date)&.to_s,
    "occurrence_count"    => r.try(:occurrence_count),
  }.compact
end

op, data = SureMutate.parse_argv!
family   = SureMutate.family!

case op
when "identify"
  begin
    result = RecurringTransaction.identify_patterns_for!(family)
  rescue => e
    SureMutate.fail!("identify failed: #{e.class}: #{e.message}")
  end
  active_count = family.recurring_transactions.where(status: "active").count
  SureMutate.success(
    "identified" => result,
    "active_count" => active_count,
    "recurring" => family.recurring_transactions.order(:next_expected_date).limit(50).map { |r| render_recurring(r) },
  )

when "cleanup_stale"
  begin
    result = RecurringTransaction.cleanup_stale_for(family)
  rescue => e
    SureMutate.fail!("cleanup_stale failed: #{e.class}: #{e.message}")
  end
  SureMutate.success("cleaned" => result)

when "mark_active", "mark_inactive"
  id = data["id"]
  SureMutate.fail!("id required") if id.to_s.strip.empty?
  rec = family.recurring_transactions.find_by(id: id)
  SureMutate.not_found!("recurring_transaction", id) unless rec

  begin
    op == "mark_active" ? rec.mark_active! : rec.mark_inactive!
  rescue ActiveRecord::RecordInvalid
    SureMutate.validation_error!(rec)
  rescue => e
    SureMutate.fail!("#{op} failed: #{e.class}: #{e.message}")
  end
  SureMutate.success("recurring" => render_recurring(rec.reload))

else
  SureMutate.fail!("unknown op '#{op}' — must be identify | cleanup_stale | mark_active | mark_inactive")
end
