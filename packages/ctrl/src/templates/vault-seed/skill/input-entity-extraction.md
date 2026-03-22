---
type: skill
title: Input Processing — Entity Extraction
domain: input_processing
tier: 1
related:
  - "skill/input-noise-filtering.md"
---

# Input Processing — Entity Extraction

How to extract people, organizations, and places from incoming content.

## Methodology
1. Scan the content for proper nouns and named references
2. Classify each as person, org, or place
3. Check existing vault records for matches (avoid duplicates)
4. For new entities, create minimal records with available context

## Person Detection
- Email senders (From: header)
- Names mentioned in body text
- Signatures at the end of emails
- CC/BCC recipients

## Organization Detection
- Email domains
- Company names in signatures or body
- Mentioned vendors, clients, partners

## Place Detection
- Physical addresses
- City/country references
- Project location names

## Deduplication
- Check vault person/ and org/ folders before creating
- Match on name similarity (not exact — "Dave" = "David")
- When unsure, create the record — better to merge later than lose data
