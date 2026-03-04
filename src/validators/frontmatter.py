"""Validate vault record frontmatter."""

from __future__ import annotations

from typing import Any

import yaml
from temporalio import activity

from src.validators.schema import (
    VALID_VAULT_TYPES,
    ValidationResult,
)


def parse_frontmatter(content: str) -> tuple[dict[str, Any], str]:
    """Parse YAML frontmatter from markdown content.

    Returns (frontmatter_dict, body).
    """
    if not content.startswith("---"):
        return {}, content

    parts = content.split("---", 2)
    if len(parts) < 3:
        return {}, content

    try:
        fm = yaml.safe_load(parts[1]) or {}
    except yaml.YAMLError:
        fm = {}

    return fm, parts[2].strip()


def validate_frontmatter(content: str) -> ValidationResult:
    """Validate that content has valid frontmatter with required fields."""
    result = ValidationResult(valid=True)

    if not content.startswith("---"):
        result.add_error("Missing frontmatter delimiters")
        return result

    fm, _ = parse_frontmatter(content)
    if not fm:
        result.add_error("Empty or invalid frontmatter YAML")
        return result

    # Required fields
    if "type" not in fm:
        result.add_error("Missing required field: type")
    elif fm["type"] not in VALID_VAULT_TYPES:
        result.add_error(f"Invalid type: {fm['type']}. Valid: {sorted(VALID_VAULT_TYPES)}")

    if "name" not in fm:
        result.add_error("Missing required field: name")

    return result


@activity.defn
async def validate_classification(classification: dict[str, Any]) -> ValidationResult:
    """Validate a classification result from the Clerk."""
    from src.validators.schema import VALID_CLASSIFICATION_TYPES

    result = ValidationResult(valid=True)

    ctype = classification.get("type")
    if not ctype:
        result.add_error("Missing classification type")
    elif ctype not in VALID_CLASSIFICATION_TYPES:
        result.add_error(f"Invalid classification type: {ctype}")

    title = classification.get("title")
    if not title or not isinstance(title, str):
        result.add_error("Missing or invalid title")

    summary = classification.get("summary")
    if not summary or not isinstance(summary, str):
        result.add_error("Missing or invalid summary")

    entities = classification.get("entities", [])
    if not isinstance(entities, list):
        result.add_error("entities must be a list")

    tags = classification.get("tags", [])
    if not isinstance(tags, list):
        result.add_error("tags must be a list")
    elif len(tags) > 5:
        result.add_error("Maximum 5 tags allowed")

    return result
