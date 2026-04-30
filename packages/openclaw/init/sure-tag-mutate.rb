# frozen_string_literal: true
#
# Tag merge-with-replacement via Rails runner.
#
# Sure's REST API already has tag CRUD (GET/POST/PATCH/DELETE /tags).
# What it does NOT expose is the "delete this tag and re-tag everything
# under it with another tag" merge flow that the web UI handles in
# tag/deletions_controller. This script adds that one operation; for
# plain create/update/destroy callers should keep using the public REST
# endpoints (we proxy them through /api/v1/sure/tags).
#
# Usage:
#   bin/rails runner sure-tag-mutate.rb <op> <payload-json-path>
#   op: replace_and_destroy
#
# Source-of-truth references (we-promise/sure @ main):
#   app/models/tag.rb                          — Tag#replace_and_destroy!(replacement)
#   app/controllers/tag/deletions_controller.rb — web flow

require_relative "sure-mutate-base"

op, data = SureMutate.parse_argv!
family   = SureMutate.family!

case op
when "replace_and_destroy"
  id             = data["id"]
  replacement_id = data["replacement_id"]
  SureMutate.fail!("id required") if id.to_s.strip.empty?
  SureMutate.fail!("replacement_id required") if replacement_id.to_s.strip.empty?

  tag         = family.tags.find_by(id: id)
  SureMutate.not_found!("tag", id) unless tag
  replacement = family.tags.find_by(id: replacement_id)
  SureMutate.not_found!("replacement_tag", replacement_id) unless replacement

  if tag.id == replacement.id
    SureMutate.fail!("replacement cannot be the same as the tag being destroyed", "validation_error")
  end

  begin
    if tag.respond_to?(:replace_and_destroy!)
      tag.replace_and_destroy!(replacement)
    else
      # Fallback: walk taggings directly.
      Tag.transaction do
        Tagging.where(tag_id: tag.id).update_all(tag_id: replacement.id)
        tag.destroy!
      end
    end
  rescue ActiveRecord::RecordInvalid
    SureMutate.validation_error!(tag)
  rescue => e
    SureMutate.fail!("destroy failed: #{e.class}: #{e.message}")
  end

  SureMutate.success("deleted" => id, "replacement_id" => replacement.id)

else
  SureMutate.fail!("unknown op '#{op}' — only replace_and_destroy is supported (use the REST tags endpoints for create/update/delete)")
end
