---
type: instinct
name: route-noise-to-log
status: active
description: "Auto-route noise-tier senders to stream log"
input_patterns:
  sender_domains: ['email.wy-efile.com', 'primanet.hu', 'unity3d.com', 'email.github.com', 'mail.wyoming-reports.com', 'crwwgroup.net', 'seobotai.com', 'mail.kilocode.ai', 'em1.cloudflare.com', 'payments.google.com']
  subject_keywords: []
  attachment_types: []
  input_types: ['email']
routing_rule:
  destination_type: stream
  destination: "tier2 stream-log"
  destination_resolver: null
  process: "archive"
  default_assignee: ""
confidence_score: 0.9
observation_count: 0
observations:
  []
last_reflection: 2026-05-23
matching_weights:
  domain: 0.3
  keywords: 0.3
  input_type: 0.15
  attachment: 0.15
  tags: 0.1
created: 2026-05-23
updated: 2026-05-23
tags: ['onboarding', 'noise', 'auto-generated']
---

## Routing Logic
Route noise-tier senders directly to stream log without triage.

## Exceptions
None defined yet.
