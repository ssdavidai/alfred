# frozen_string_literal: true
#
# Category CRUD via Rails runner for the Sure self-hosted finance app.
#
# Sure's REST API exposes category READS only (`GET /categories`,
# `GET /categories/{id}`). Category creation, rename, and deletion
# (with re-categorisation of existing transactions) is web-UI only.
# This script gives ctrl-api a programmatic CRUD path mirroring
# Sure's CategoriesController + Category::DeletionsController.
#
# Usage:
#   bin/rails runner sure-category-mutate.rb <op> <payload-json-path>
#   op: bootstrap | create | update | replace_and_destroy
#
# Source-of-truth references (we-promise/sure @ main):
#   app/models/category.rb                       — Category model
#       .bootstrap! is a class method but its body uses find_or_create_by!
#       without a family scope — call it via the association proxy
#       (`family.categories.bootstrap!`) so the relation's default scope
#       supplies family_id automatically.
#       #replace_and_destroy!(replacement)       (takes Category object, NOT id)
#   app/controllers/categories_controller.rb     — web equivalent

require_relative "sure-mutate-base"

# NOTE: `classification` was removed upstream; the column is now
# `classification_unused` (legacy, default "expense"). Do NOT expose it.
PERMITTED_ATTRS = %w[name color lucide_icon parent_id].freeze

def find_category(family, id)
  family.categories.find_by(id: id)
end

def render_category(c)
  return nil unless c
  {
    "id"          => c.id,
    "name"        => c.name,
    "color"       => c.color,
    "lucide_icon" => c.try(:lucide_icon),
    "parent_id"   => c.parent_id,
  }.compact
end

op, data = SureMutate.parse_argv!
family   = SureMutate.family!

case op
when "bootstrap"
  # Seeds the default category set if categories are missing. Idempotent.
  # Must be invoked through the association proxy so find_or_create_by!
  # picks up the family_id from the relation's default scope.
  begin
    family.categories.bootstrap!
  rescue => e
    SureMutate.fail!("bootstrap failed: #{e.class}: #{e.message}")
  end
  SureMutate.success(
    "categories" => family.categories.alphabetically.map { |c| render_category(c) },
  )

when "create"
  attrs = data.slice(*PERMITTED_ATTRS)
  SureMutate.fail!("name required") if attrs["name"].to_s.strip.empty?

  category = family.categories.new(attrs)
  begin
    category.save!
  rescue ActiveRecord::RecordInvalid
    SureMutate.validation_error!(category)
  rescue => e
    SureMutate.fail!("create failed: #{e.class}: #{e.message}")
  end

  SureMutate.success("category" => render_category(category))

when "update"
  id = data["id"]
  SureMutate.fail!("id required for update") if id.to_s.strip.empty?
  category = find_category(family, id)
  SureMutate.not_found!("category", id) unless category

  attrs = data.slice(*PERMITTED_ATTRS)
  begin
    category.update!(attrs)
  rescue ActiveRecord::RecordInvalid
    SureMutate.validation_error!(category)
  rescue => e
    SureMutate.fail!("update failed: #{e.class}: #{e.message}")
  end

  SureMutate.success("category" => render_category(category))

when "replace_and_destroy"
  id             = data["id"]
  replacement_id = data["replacement_id"]
  SureMutate.fail!("id required") if id.to_s.strip.empty?

  category = find_category(family, id)
  SureMutate.not_found!("category", id) unless category

  replacement = nil
  if replacement_id.to_s.strip.length > 0
    replacement = find_category(family, replacement_id)
    SureMutate.not_found!("replacement_category", replacement_id) unless replacement
    if replacement.id == category.id
      SureMutate.fail!("replacement cannot be the same as the category being destroyed", "validation_error")
    end
  end

  begin
    if replacement && category.respond_to?(:replace_and_destroy!)
      category.replace_and_destroy!(replacement)
    else
      # Fallback when no replacement supplied: re-parent transactions to nil and destroy.
      Category.transaction do
        family.transactions.where(category_id: category.id).update_all(category_id: nil)
        category.destroy!
      end
    end
  rescue ActiveRecord::RecordInvalid
    SureMutate.validation_error!(category)
  rescue => e
    SureMutate.fail!("destroy failed: #{e.class}: #{e.message}")
  end

  SureMutate.success("deleted" => id, "replacement_id" => replacement&.id)

else
  SureMutate.fail!("unknown op '#{op}' — must be bootstrap | create | update | replace_and_destroy")
end
