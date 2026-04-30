# frozen_string_literal: true
#
# Family invitation mutations via Rails runner for the Sure self-hosted
# finance app.
#
# Usage:
#   bin/rails runner sure-invitation-mutate.rb <op> <payload-json-path>
#   op: create | destroy
#
# DELIBERATELY OUT OF SCOPE: accept. Sure's Invitation#accept_for(user)
# requires either a token-bearing browser session or programmatic user
# resolution that bypasses Sure's auth model. The right shape is:
#   1. Sir creates an invitation here     → POST /invitations
#   2. Alfred emails the invite URL out   → invitee opens browser
#   3. Invitee accepts in the Sure UI     → token-bearing session
# Forcing accept_for from this side would either silently impersonate
# the invitee or require synthesising a session, both wrong shapes for
# a household-finance app. Document this in SKILL.md.
#
# Source-of-truth references (we-promise/sure @ pinned SHA):
#   app/models/invitation.rb
#     belongs_to :family, :inviter (class_name "User")
#     validates :role inclusion %w[admin member guest]
#     before_create :set_expiration  (default 7 days)
#     before_validation :generate_token  (cryptographically random)

require_relative "sure-mutate-base"

PERMITTED_ATTRS = %w[email role].freeze

def render_invitation(inv)
  {
    "id"          => inv.id,
    "email"       => inv.email,
    "role"        => inv.role,
    "expires_at"  => inv.expires_at&.iso8601,
    "accepted_at" => inv.accepted_at&.iso8601,
    "token"       => inv.token,                          # so Alfred can email the URL
    "accept_url_path" => "/invitations/#{inv.token}/accept",  # caller composes scheme/host
  }.compact
end

op, data = SureMutate.parse_argv!
family   = SureMutate.family!

case op
when "create"
  attrs = data.slice(*PERMITTED_ATTRS)
  attrs["role"] ||= "member"
  SureMutate.fail!("email required") if attrs["email"].to_s.strip.empty?

  # Inviter must be an admin in this family — pick the family owner.
  # Sir runs the household; programmatic invites originate from him.
  inviter = family.users.where(role: "admin").first || family.users.first
  SureMutate.fail!("no admin user found in family — cannot create invitation", "validation_error") unless inviter

  inv = family.invitations.new(attrs.merge("inviter" => inviter))
  begin
    inv.save!
  rescue ActiveRecord::RecordInvalid
    SureMutate.validation_error!(inv)
  rescue => e
    SureMutate.fail!("create failed: #{e.class}: #{e.message}")
  end
  SureMutate.success("invitation" => render_invitation(inv))

when "destroy"
  id = data["id"]
  SureMutate.fail!("id required") if id.to_s.strip.empty?
  inv = family.invitations.find_by(id: id)
  SureMutate.not_found!("invitation", id) unless inv

  begin
    inv.destroy!
  rescue => e
    SureMutate.fail!("destroy failed: #{e.class}: #{e.message}")
  end
  SureMutate.success("deleted" => id)

else
  SureMutate.fail!("unknown op '#{op}' — must be create | destroy. Accept is browser-only by design.")
end
