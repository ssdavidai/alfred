# frozen_string_literal: true
#
# User-preference mutations via Rails runner for the Sure self-hosted
# finance app.
#
# DELIBERATELY NARROW SCOPE: only User-level preferences (display
# settings + name + AI toggle), not the global `Setting` keys (those
# touch hosting/provider/exchange-rate config and are nuclear-adjacent
# — Sir would not want Alfred toggling them autonomously).
#
# Usage:
#   bin/rails runner sure-settings-mutate.rb set_user_pref <payload-json-path>
#
# Source-of-truth references (we-promise/sure @ pinned SHA):
#   db/schema.rb users table — supported preference columns:
#     first_name, last_name, ai_enabled, show_ai_sidebar, show_sidebar,
#     theme, rule_prompts_disabled, default_period, default_account_id,
#     default_account_order, ui_layout, locale, preferences (jsonb)

require_relative "sure-mutate-base"

PERMITTED_USER_PREFS = %w[
  first_name last_name
  theme locale ui_layout
  show_sidebar show_ai_sidebar ai_enabled
  rule_prompts_disabled
  default_period default_account_order default_account_id
].freeze

def render_user(u)
  {
    "id"                    => u.id,
    "first_name"            => u.first_name,
    "last_name"             => u.last_name,
    "email"                 => u.email,
    "role"                  => u.role,
    "ai_enabled"            => u.ai_enabled,
    "show_ai_sidebar"       => u.show_ai_sidebar,
    "show_sidebar"          => u.show_sidebar,
    "theme"                 => u.theme,
    "locale"                => u.locale,
    "ui_layout"             => u.ui_layout,
    "rule_prompts_disabled" => u.rule_prompts_disabled,
    "default_period"        => u.default_period,
    "default_account_order" => u.default_account_order,
    "default_account_id"    => u.default_account_id,
  }.compact
end

op, data = SureMutate.parse_argv!
family   = SureMutate.family!

case op
when "set_user_pref"
  user_id = data["user_id"]
  user =
    if user_id.to_s.strip.length > 0
      family.users.find_by(id: user_id)
    else
      # Default to the family owner if no user_id supplied.
      family.users.where(role: "admin").first || family.users.first
    end
  SureMutate.not_found!("user", user_id) unless user

  attrs = data.slice(*PERMITTED_USER_PREFS)
  SureMutate.fail!("no permitted preferences in payload", "validation_error") if attrs.empty?

  begin
    user.update!(attrs)
  rescue ActiveRecord::RecordInvalid
    SureMutate.validation_error!(user)
  rescue => e
    SureMutate.fail!("update failed: #{e.class}: #{e.message}")
  end
  SureMutate.success("user" => render_user(user.reload))

else
  SureMutate.fail!(
    "unknown op '#{op}' — must be set_user_pref. Hosting/provider Setting keys are not exposed here by design."
  )
end
