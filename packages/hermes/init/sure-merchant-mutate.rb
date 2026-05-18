# frozen_string_literal: true
#
# Merchant CRUD + merge via Rails runner.
#
# Sure's REST API exposes merchant READS only (`GET /merchants`,
# `GET /merchants/{id}`). The web UI's family_merchants_controller
# handles create/update/destroy/merge/enhance. This script mirrors
# that surface — but only against FamilyMerchant records (not the
# upstream ProviderMerchant catalogue, which Sure manages itself).
#
# Usage:
#   bin/rails runner sure-merchant-mutate.rb <op> <payload-json-path>
#   op: create | update | destroy | merge | enhance
#
# Source-of-truth references (we-promise/sure @ main):
#   app/models/merchant.rb                            — base STI class
#   app/models/family_merchant.rb                     — user-managed merchants
#   app/models/merchant/merger.rb                     — Merchant::Merger service
#   app/controllers/family_merchants_controller.rb    — web flow

require_relative "sure-mutate-base"

PERMITTED_ATTRS = %w[name color website_url].freeze

def find_family_merchant(family, id)
  family.merchants.where(type: "FamilyMerchant").find_by(id: id)
end

def render_merchant(m)
  return nil unless m
  {
    "id"          => m.id,
    "name"        => m.name,
    "color"       => m.color,
    "website_url" => m.try(:website_url),
    "type"        => m.type,
    "logo_url"    => m.respond_to?(:logo_url) ? m.logo_url : nil,
  }.compact
end

op, data = SureMutate.parse_argv!
family   = SureMutate.family!

case op
when "create"
  attrs = data.slice(*PERMITTED_ATTRS)
  SureMutate.fail!("name required") if attrs["name"].to_s.strip.empty?

  merchant = FamilyMerchant.new(attrs.merge("family" => family))
  begin
    merchant.save!
  rescue ActiveRecord::RecordInvalid
    SureMutate.validation_error!(merchant)
  rescue => e
    SureMutate.fail!("create failed: #{e.class}: #{e.message}")
  end

  SureMutate.success("merchant" => render_merchant(merchant))

when "update"
  id = data["id"]
  SureMutate.fail!("id required for update") if id.to_s.strip.empty?
  merchant = find_family_merchant(family, id)
  SureMutate.not_found!("merchant", id) unless merchant

  attrs = data.slice(*PERMITTED_ATTRS)
  begin
    merchant.update!(attrs)
  rescue ActiveRecord::RecordInvalid
    SureMutate.validation_error!(merchant)
  rescue => e
    SureMutate.fail!("update failed: #{e.class}: #{e.message}")
  end

  SureMutate.success("merchant" => render_merchant(merchant))

when "destroy"
  id = data["id"]
  SureMutate.fail!("id required for destroy") if id.to_s.strip.empty?
  merchant = find_family_merchant(family, id)
  SureMutate.not_found!("merchant", id) unless merchant

  begin
    merchant.destroy!
  rescue => e
    SureMutate.fail!("destroy failed: #{e.class}: #{e.message}")
  end

  SureMutate.success("deleted" => id)

when "merge"
  target_id  = data["target_merchant_id"]
  source_ids = data["source_merchant_ids"]
  SureMutate.fail!("target_merchant_id required") if target_id.to_s.strip.empty?
  SureMutate.fail!("source_merchant_ids must be a non-empty array") unless source_ids.is_a?(Array) && source_ids.any?

  target = find_family_merchant(family, target_id)
  SureMutate.not_found!("target_merchant", target_id) unless target

  sources = source_ids.map { |sid| find_family_merchant(family, sid) }
  missing = source_ids.zip(sources).select { |_, m| m.nil? }.map(&:first)
  SureMutate.not_found!("source_merchants", missing.join(",")) if missing.any?

  if sources.any? { |s| s.id == target.id }
    SureMutate.fail!("source list cannot include the target", "validation_error")
  end

  begin
    if defined?(Merchant::Merger)
      Merchant::Merger.new(family: family, target_merchant: target, source_merchants: sources).merge!
    else
      # Fallback: reassign transactions directly and destroy sources.
      Merchant.transaction do
        family.transactions.where(merchant_id: source_ids).update_all(merchant_id: target.id)
        sources.each(&:destroy!)
      end
    end
  rescue ActiveRecord::RecordInvalid
    SureMutate.validation_error!(target)
  rescue => e
    SureMutate.fail!("merge failed: #{e.class}: #{e.message}")
  end

  SureMutate.success(
    "target_merchant_id"  => target.id,
    "merged_count"        => sources.size,
    "merged_source_ids"   => source_ids,
  )

when "enhance"
  begin
    if defined?(EnhanceProviderMerchantsJob)
      EnhanceProviderMerchantsJob.perform_later(family.id)
      SureMutate.success("enqueued" => "EnhanceProviderMerchantsJob", "family_id" => family.id)
    else
      SureMutate.fail!("EnhanceProviderMerchantsJob not available in this Sure version", "validation_error")
    end
  rescue => e
    SureMutate.fail!("enhance failed: #{e.class}: #{e.message}")
  end

else
  SureMutate.fail!("unknown op '#{op}' — must be create | update | destroy | merge | enhance")
end
