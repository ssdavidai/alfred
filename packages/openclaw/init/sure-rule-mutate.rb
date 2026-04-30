# frozen_string_literal: true
#
# Rule CRUD via Rails runner for the Sure self-hosted finance app.
#
# Sure has a Rules engine (Rule + Rule::Condition + Rule::Action) but
# no public REST endpoint — Settings → Rules in the web UI is the only
# documented path. This script gives ctrl-api a programmatic route so
# Alfred can analyse transactions, propose rules, confirm with Sir,
# and create them autonomously.
#
# Usage:
#   bin/rails runner sure-rule-mutate.rb <op> <payload-json-path>
#   op: list | show | create | update | delete | apply | preview
#
# stdout: a single JSON line on success: {"ok": true, ...}
# stdout: a single JSON line on failure: {"ok": false, "error": "..."}
# Always exits 0 — caller distinguishes by parsing the JSON.
#
# Source-of-truth references (we-promise/sure @ main):
#   app/models/rule.rb                                — Rule + apply / affected_resource_count
#   app/models/rule/condition.rb                      — nested attrs, compound support
#   app/models/rule/action.rb                         — action_type + value
#   app/models/rule/registry/transaction_resource.rb  — registered filters + executors
#   app/models/rule/condition_filter.rb               — operators per type
#   app/models/rule/action_executor/set_as_transfer_or_payment.rb — loan-payment kind

require "json"

EXIT_OK = 0
SUCCESS = ->(payload) {
  puts JSON.generate({ "ok" => true }.merge(payload))
  exit EXIT_OK
}
FAIL = ->(message, status = "error") {
  puts JSON.generate({ "ok" => false, "error" => message, "status" => status })
  exit EXIT_OK
}

op           = ARGV[0]
payload_path = ARGV[1]

FAIL.call("op argument required (list|show|create|update|delete|apply|preview)") if op.to_s.strip.empty?

data =
  if payload_path.to_s.strip.empty?
    {}
  elsif File.exist?(payload_path)
    begin
      JSON.parse(File.read(payload_path))
    rescue JSON::ParserError => e
      FAIL.call("invalid JSON payload: #{e.message}")
    end
  else
    FAIL.call("payload file missing: #{payload_path}")
  end

family = Family.first
FAIL.call("no Family record found — Sure has not been bootstrapped") unless family

# ---------- helpers ----------

def render_condition(c)
  out = {
    "id"             => c.id,
    "condition_type" => c.condition_type,
    "operator"       => c.operator,
    "value"          => c.value,
  }
  if c.compound?
    out["sub_conditions"] = c.sub_conditions.map { |sc| render_condition(sc) }
  end
  out
end

def render_action(a)
  {
    "id"          => a.id,
    "action_type" => a.action_type,
    "value"       => a.value,
  }
end

def render_rule(r, include_counts: false)
  out = {
    "id"             => r.id,
    "name"           => r.name,
    "resource_type"  => r.resource_type,
    "effective_date" => r.effective_date&.iso8601,
    "active"         => r.respond_to?(:active) ? r.active : nil,
    "conditions"     => r.conditions.where(parent_id: nil).order(:created_at, :id).map { |c| render_condition(c) },
    "actions"        => r.actions.order(:created_at, :id).map { |a| render_action(a) },
  }
  if include_counts
    begin
      out["affected_resource_count"] = r.affected_resource_count
    rescue => e
      out["affected_resource_count_error"] = "#{e.class}: #{e.message}"
    end
  end
  out
end

# Normalise caller-supplied condition/action arrays into the
# accepts_nested_attributes_for shape Rails expects.
def normalize_conditions(items)
  return [] unless items.is_a?(Array)
  items.map do |c|
    next unless c.is_a?(Hash)
    attrs = {
      "condition_type" => c["condition_type"],
      "operator"       => c["operator"],
      "value"          => c["value"]&.to_s,
    }.compact
    if c["sub_conditions"].is_a?(Array) && c["sub_conditions"].any?
      attrs["sub_conditions_attributes"] = c["sub_conditions"].map do |sc|
        {
          "condition_type" => sc["condition_type"],
          "operator"       => sc["operator"],
          "value"          => sc["value"]&.to_s,
        }.compact
      end
    end
    attrs
  end.compact
end

def normalize_actions(items)
  return [] unless items.is_a?(Array)
  items.map do |a|
    next unless a.is_a?(Hash)
    {
      "action_type" => a["action_type"],
      "value"       => a["value"]&.to_s,
    }.compact
  end.compact
end

# ---------- ops ----------

case op
when "list"
  rules = family.rules.order(created_at: :desc).limit(data["limit"]&.to_i || 100).to_a
  SUCCESS.call("rules" => rules.map { |r| render_rule(r, include_counts: false) }, "total" => rules.size)

when "show"
  id = data["id"]
  FAIL.call("id required for show") if id.to_s.strip.empty?
  rule = family.rules.find_by(id: id)
  FAIL.call("rule not found: #{id}", "not_found") unless rule
  SUCCESS.call("rule" => render_rule(rule, include_counts: true))

when "create"
  attrs = {
    "name"           => data["name"],
    "resource_type"  => data["resource_type"] || "transaction",
    "effective_date" => data["effective_date"],
    "conditions_attributes" => normalize_conditions(data["conditions"]),
    "actions_attributes"    => normalize_actions(data["actions"]),
  }.compact
  attrs["active"] = data["active"] if data.key?("active") && Rule.column_names.include?("active")

  rule = family.rules.new(attrs)

  begin
    rule.save!
  rescue ActiveRecord::RecordInvalid
    FAIL.call("validation failed: #{rule.errors.full_messages.join('; ')}", "validation_error")
  rescue => e
    FAIL.call("create failed: #{e.class}: #{e.message}")
  end

  SUCCESS.call("rule" => render_rule(rule, include_counts: true))

when "update"
  id = data["id"]
  FAIL.call("id required for update") if id.to_s.strip.empty?
  rule = family.rules.find_by(id: id)
  FAIL.call("rule not found: #{id}", "not_found") unless rule

  # Replace nested collections wholesale when supplied. Callers that
  # want surgical edits should round-trip through show + delete + create
  # rather than try to patch individual condition/action ids.
  attrs = {}
  attrs["name"]           = data["name"]            if data.key?("name")
  attrs["resource_type"]  = data["resource_type"]   if data.key?("resource_type")
  attrs["effective_date"] = data["effective_date"]  if data.key?("effective_date")
  attrs["active"]         = data["active"]          if data.key?("active") && Rule.column_names.include?("active")

  if data.key?("conditions")
    rule.conditions.where(parent_id: nil).destroy_all
    attrs["conditions_attributes"] = normalize_conditions(data["conditions"])
  end
  if data.key?("actions")
    rule.actions.destroy_all
    attrs["actions_attributes"] = normalize_actions(data["actions"])
  end

  begin
    rule.update!(attrs)
  rescue ActiveRecord::RecordInvalid
    FAIL.call("validation failed: #{rule.errors.full_messages.join('; ')}", "validation_error")
  rescue => e
    FAIL.call("update failed: #{e.class}: #{e.message}")
  end

  SUCCESS.call("rule" => render_rule(rule.reload, include_counts: true))

when "delete"
  id = data["id"]
  FAIL.call("id required for delete") if id.to_s.strip.empty?
  rule = family.rules.find_by(id: id)
  FAIL.call("rule not found: #{id}", "not_found") unless rule
  begin
    rule.destroy!
  rescue => e
    FAIL.call("delete failed: #{e.class}: #{e.message}")
  end
  SUCCESS.call("deleted" => id)

when "apply"
  id = data["id"]
  FAIL.call("id required for apply") if id.to_s.strip.empty?
  rule = family.rules.find_by(id: id)
  FAIL.call("rule not found: #{id}", "not_found") unless rule
  ignore_locks = data["ignore_attribute_locks"] ? true : false
  begin
    rule.apply(ignore_attribute_locks: ignore_locks)
  rescue => e
    FAIL.call("apply failed: #{e.class}: #{e.message}")
  end
  SUCCESS.call(
    "rule_id"                 => rule.id,
    "ignored_attribute_locks" => ignore_locks,
    "affected_resource_count" => rule.affected_resource_count
  )

when "preview"
  # Dry-run: build the Rule but don't save it. Compute the matching
  # scope and return both the count and a sample of the first 20
  # transactions that would be affected. Lets Alfred validate his
  # proposed rule with Sir before committing.
  attrs = {
    "name"           => data["name"] || "preview",
    "resource_type"  => data["resource_type"] || "transaction",
    "effective_date" => data["effective_date"],
    "conditions_attributes" => normalize_conditions(data["conditions"]),
    "actions_attributes"    => normalize_actions(data["actions"]),
  }.compact
  rule = family.rules.new(attrs)

  unless rule.valid?
    FAIL.call("preview validation failed: #{rule.errors.full_messages.join('; ')}", "validation_error")
  end

  begin
    scope = rule.send(:matching_resources_scope)
    count = scope.count
    sample = scope.includes(entry: :account).limit(20).map do |txn|
      e = txn.entry
      {
        "id"        => txn.id,
        "name"      => e.name,
        "amount"    => e.amount.to_s,
        "currency"  => e.currency,
        "date"      => e.date.to_s,
        "account"   => e.account&.name,
        "category"  => txn.category&.name,
        "merchant"  => txn.merchant&.name,
        "kind"      => txn.kind,
      }
    end
  rescue => e
    FAIL.call("preview failed: #{e.class}: #{e.message}")
  end

  SUCCESS.call("affected_resource_count" => count, "sample" => sample)

when "apply_all"
  # Run every family rule against existing transactions in one pass —
  # the equivalent of clicking "Apply all" in the Sure UI's Rules page.
  ignore_locks = data["ignore_attribute_locks"] ? true : false
  results = []
  family.rules.order(:created_at).find_each do |r|
    begin
      r.apply(ignore_attribute_locks: ignore_locks)
      results << {
        "id" => r.id, "name" => r.name,
        "affected_resource_count" => r.affected_resource_count,
      }
    rescue => e
      results << { "id" => r.id, "name" => r.name, "error" => "#{e.class}: #{e.message}" }
    end
  end
  SUCCESS.call(
    "rules_applied"          => results.size,
    "ignored_attribute_locks" => ignore_locks,
    "results"                => results,
  )

else
  FAIL.call("unknown op '#{op}' — must be list|show|create|update|delete|apply|apply_all|preview")
end
