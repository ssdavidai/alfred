# frozen_string_literal: true
#
# Account-share mutations via Rails runner for the Sure self-hosted finance app.
#
# Sure supports sharing an account with another user in the same
# family. The web UI (Settings → Account → Sharing) creates/updates/
# destroys `AccountShare` rows. This script gives Alfred programmatic
# access so Sir can say "share Example Bank EUR with my spouse, view-only".
#
# Usage:
#   bin/rails runner sure-share-mutate.rb <op> <payload-json-path>
#   op: create | update | delete
#
# Source-of-truth references (we-promise/sure @ pinned SHA):
#   app/models/account_share.rb
#     PERMISSIONS = %w[full_control read_write read_only]
#     belongs_to :account, :user
#     unique on (account_id, user_id)
#     validates user is in the same family as the account owner

require_relative "sure-mutate-base"

PERMITTED_ATTRS = %w[permission include_in_finances].freeze

def render_share(s)
  {
    "id"                  => s.id,
    "account_id"          => s.account_id,
    "user_id"             => s.user_id,
    "permission"          => s.permission,
    "include_in_finances" => s.include_in_finances,
  }.compact
end

# Look up a target user for sharing — either by id or by email.
def find_user(family, data)
  if data["user_id"].to_s.strip.length > 0
    return family.users.find_by(id: data["user_id"])
  end
  if data["email"].to_s.strip.length > 0
    return family.users.find_by("LOWER(email) = ?", data["email"].to_s.downcase.strip)
  end
  nil
end

op, data = SureMutate.parse_argv!
family   = SureMutate.family!

case op
when "create"
  account_id = data["account_id"]
  SureMutate.fail!("account_id required") if account_id.to_s.strip.empty?
  account = family.accounts.find_by(id: account_id)
  SureMutate.not_found!("account", account_id) unless account

  user = find_user(family, data)
  SureMutate.fail!("user_id or email required (must be a member of the same family)", "validation_error") unless user

  attrs = data.slice(*PERMITTED_ATTRS)
  attrs["permission"] ||= "read_only"

  share = account.account_shares.new(attrs.merge("user_id" => user.id))
  begin
    share.save!
  rescue ActiveRecord::RecordInvalid
    SureMutate.validation_error!(share)
  rescue => e
    SureMutate.fail!("create failed: #{e.class}: #{e.message}")
  end
  SureMutate.success("share" => render_share(share))

when "update"
  id = data["id"]
  SureMutate.fail!("id required") if id.to_s.strip.empty?
  share = AccountShare.joins(:account).where(accounts: { family_id: family.id }).find_by(id: id)
  SureMutate.not_found!("account_share", id) unless share

  attrs = data.slice(*PERMITTED_ATTRS)
  begin
    share.update!(attrs)
  rescue ActiveRecord::RecordInvalid
    SureMutate.validation_error!(share)
  rescue => e
    SureMutate.fail!("update failed: #{e.class}: #{e.message}")
  end
  SureMutate.success("share" => render_share(share))

when "delete"
  id = data["id"]
  SureMutate.fail!("id required") if id.to_s.strip.empty?
  share = AccountShare.joins(:account).where(accounts: { family_id: family.id }).find_by(id: id)
  SureMutate.not_found!("account_share", id) unless share

  begin
    share.destroy!
  rescue => e
    SureMutate.fail!("delete failed: #{e.class}: #{e.message}")
  end
  SureMutate.success("deleted" => id)

else
  SureMutate.fail!("unknown op '#{op}' — must be create | update | delete")
end
