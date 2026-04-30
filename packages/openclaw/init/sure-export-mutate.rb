# frozen_string_literal: true
#
# Family data export via Rails runner for the Sure self-hosted finance app.
#
# Sure's web UI lets Sir export his family's full data as a zip
# (transactions CSV + accounts JSON + holdings + recurring + …).
# This script kicks off the same job programmatically so Alfred can
# offer "I can package up everything in Sure for you" when Sir wants
# a backup or a reconciliation snapshot.
#
# Usage:
#   bin/rails runner sure-export-mutate.rb create <payload-json-path>
#
# Source-of-truth references (we-promise/sure @ pinned SHA):
#   app/models/family_export.rb     — pending → processing → completed
#   app/jobs/family_data_export_job.rb

require_relative "sure-mutate-base"

op, data = SureMutate.parse_argv!
family   = SureMutate.family!

case op
when "create"
  begin
    fx = family.family_exports.create!
  rescue ActiveRecord::RecordInvalid
    SureMutate.validation_error!(fx)
  rescue => e
    SureMutate.fail!("create failed: #{e.class}: #{e.message}")
  end

  begin
    FamilyDataExportJob.perform_later(fx)
  rescue => e
    # The export row was created; only the job enqueue failed. Caller
    # can retry; surface so we don't claim everything succeeded.
    SureMutate.fail!("export row created (id=#{fx.id}) but job enqueue failed: #{e.class}: #{e.message}")
  end

  SureMutate.success(
    "export" => {
      "id"         => fx.id,
      "status"     => fx.status,
      "filename"   => fx.filename,
      "created_at" => fx.created_at.iso8601,
    },
    "job_enqueued" => "FamilyDataExportJob",
  )

else
  SureMutate.fail!("unknown op '#{op}' — must be create")
end
