# frozen_string_literal: true
#
# Budget mutations via Rails runner for the Sure self-hosted finance app.
#
# Sure's web UI exposes budget creation, copy-from-prior-month, and
# per-category budget amount edits. None of these are in the public
# REST API. This script gives Alfred programmatic access so he can set
# up Sir's monthly budgets, roll them forward at month-end, and adjust
# category targets when Sir's pattern shifts.
#
# Usage:
#   bin/rails runner sure-budget-mutate.rb <op> <payload-json-path>
#   op: find_or_bootstrap | copy_from | update_category_budget
#
# Source-of-truth references (we-promise/sure @ pinned SHA):
#   app/models/budget.rb
#     .find_or_bootstrap(family, start_date:, user: nil)
#       — creates the Budget shell + sync_budget_categories from the
#         current category set; idempotent
#     #copy_from!(source_budget) — clones budgeted_spending values
#   app/models/budget_category.rb
#     #update_budgeted_spending!(amount)

require_relative "sure-mutate-base"

def render_budget(b)
  {
    "id"         => b.id,
    "start_date" => b.start_date&.to_s,
    "end_date"   => b.end_date&.to_s,
    "currency"   => b.currency,
    "budgeted_spending" => b.try(:budgeted_spending)&.to_s,
    "expected_income"   => b.try(:expected_income)&.to_s,
    "category_count"    => b.budget_categories.count,
  }.compact
end

def render_budget_category(bc)
  {
    "id"                => bc.id,
    "budget_id"         => bc.budget_id,
    "category_id"       => bc.category_id,
    "budgeted_spending" => bc.try(:budgeted_spending)&.to_s,
  }.compact
end

op, data = SureMutate.parse_argv!
family   = SureMutate.family!

case op
when "find_or_bootstrap"
  start_date_str = data["start_date"]
  SureMutate.fail!("start_date required (YYYY-MM-DD)") if start_date_str.to_s.strip.empty?
  begin
    start_date = Date.parse(start_date_str)
  rescue ArgumentError => e
    SureMutate.fail!("invalid start_date: #{e.message}", "validation_error")
  end

  user = family.users.where(role: "admin").first || family.users.first

  budget =
    begin
      Budget.find_or_bootstrap(family, start_date: start_date, user: user)
    rescue => e
      SureMutate.fail!("find_or_bootstrap failed: #{e.class}: #{e.message}")
    end

  unless budget
    SureMutate.fail!(
      "start_date #{start_date} is outside the valid budget window (>= 2y ago, <= 2y ahead, family scoped)",
      "validation_error"
    )
  end

  SureMutate.success(
    "budget" => render_budget(budget),
    "categories" => budget.budget_categories.includes(:category).map { |bc| render_budget_category(bc) },
  )

when "copy_from"
  target_id = data["budget_id"] || data["target_id"]
  source_id = data["source_budget_id"]
  SureMutate.fail!("budget_id (target) and source_budget_id required") if target_id.to_s.strip.empty? || source_id.to_s.strip.empty?

  target = family.budgets.find_by(id: target_id)
  SureMutate.not_found!("budget", target_id) unless target

  source = family.budgets.find_by(id: source_id)
  SureMutate.not_found!("source_budget", source_id) unless source

  begin
    target.copy_from!(source)
  rescue ActiveRecord::RecordInvalid
    SureMutate.validation_error!(target)
  rescue => e
    SureMutate.fail!("copy_from failed: #{e.class}: #{e.message}")
  end
  SureMutate.success("budget" => render_budget(target.reload))

when "update_category_budget"
  id = data["id"] || data["budget_category_id"]
  amount = data["budgeted_spending"] || data["amount"]
  SureMutate.fail!("id (budget_category_id) required") if id.to_s.strip.empty?
  SureMutate.fail!("budgeted_spending (amount) required") if amount.nil?

  bc = BudgetCategory
        .joins(budget: :family)
        .where(families: { id: family.id })
        .find_by(id: id)
  SureMutate.not_found!("budget_category", id) unless bc

  begin
    bc.update_budgeted_spending!(amount)
  rescue ActiveRecord::RecordInvalid
    SureMutate.validation_error!(bc)
  rescue => e
    SureMutate.fail!("update_category_budget failed: #{e.class}: #{e.message}")
  end
  SureMutate.success("budget_category" => render_budget_category(bc.reload))

else
  SureMutate.fail!("unknown op '#{op}' — must be find_or_bootstrap | copy_from | update_category_budget")
end
