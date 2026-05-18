# frozen_string_literal: true
#
# Shared envelope + helpers for sure-*-mutate.rb scripts.
#
# Each mutation script does:
#
#   require_relative "sure-mutate-base"
#   op, data = SureMutate.parse_argv!
#   family   = SureMutate.family!
#
#   case op
#   when "create"
#     ...
#     SureMutate.success("transfer" => render_transfer(transfer))
#   when "update"
#     ...
#   else
#     SureMutate.fail!("unknown op '#{op}'")
#   end
#
# Contract on the wire (matches sure-account-mutate.rb / sure-rule-mutate.rb):
#   stdout:  ONE JSON line, either {"ok": true, ...} or
#                              {"ok": false, "error": "...", "status": "..."}
#   exit:    always 0 — caller distinguishes by parsing JSON. Reserve non-zero
#            for genuine Rails-runner crashes that produce no JSON line.

require "json"

module SureMutate
  EXIT_OK = 0

  def self.success(payload = {})
    puts JSON.generate({ "ok" => true }.merge(payload))
    exit EXIT_OK
  end

  def self.fail!(message, status = "error")
    puts JSON.generate({ "ok" => false, "error" => message, "status" => status })
    exit EXIT_OK
  end

  # Returns [op, data]. data is an empty hash if no payload file was supplied.
  def self.parse_argv!
    op = ARGV[0]
    payload_path = ARGV[1]

    fail!("op argument required") if op.to_s.strip.empty?

    data =
      if payload_path.to_s.strip.empty?
        {}
      elsif File.exist?(payload_path)
        begin
          JSON.parse(File.read(payload_path))
        rescue JSON::ParserError => e
          fail!("invalid JSON payload: #{e.message}")
        end
      else
        fail!("payload file missing: #{payload_path}")
      end

    [op, data]
  end

  # Single-tenant assumption (matches sure-bootstrap.rb): one Family per
  # Sure deployment. If/when Sure grows multi-family-per-instance support,
  # callers should accept family_id in payload and switch this to a lookup.
  def self.family!
    fam = Family.first
    fail!("no Family record found — Sure has not been bootstrapped") unless fam
    fam
  end

  # Map an ActiveRecord::RecordInvalid (or a saved-but-invalid record) into
  # the validation_error envelope. Always exits.
  def self.validation_error!(record, prefix: "validation failed")
    msgs =
      if record.respond_to?(:errors) && record.errors.any?
        record.errors.full_messages.join("; ")
      else
        "unknown"
      end
    fail!("#{prefix}: #{msgs}", "validation_error")
  end

  def self.not_found!(resource, id)
    fail!("#{resource} not found: #{id}", "not_found")
  end
end
