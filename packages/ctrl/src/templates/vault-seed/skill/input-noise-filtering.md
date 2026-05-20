---
type: skill
title: Input Processing — Noise Filtering
domain: input_processing
tier: 1
related:
  - "skill/input-entity-extraction.md"
---

# Input Processing — Noise Filtering

How to determine if an input is noise (should be discarded or archived) vs signal (should be classified and processed).

## Noise Indicators
- Automated notifications with no actionable content
- Marketing emails, newsletters, promotional content
- Auto-replies, out-of-office messages
- Duplicate content already processed
- Empty or near-empty files with no meaningful text
- System-generated logs or metrics dumps

## Signal Indicators (NOT noise)
- Contains a request, question, or action item
- References a known person, project, or organization
- Contains a decision, agreement, or commitment
- Has attachments worth preserving (contracts, invoices, reports)
- Contains dates, deadlines, or scheduling information
- Mentions financial figures, quotes, or terms

## Edge Cases
- Newsletters FROM known contacts about relevant topics → note, not noise
- Automated reports with useful data → note
- Calendar invites → event
- Read receipts → noise
