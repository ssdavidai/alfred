---
type: instinct
name: route-newsletters-to-log
status: active
description: "Auto-route newsletter senders to stream log"
input_patterns:
  sender_domains: ['linear.app', 'stan.store', 'email.vidiq.com', 'notification.circle.so']
  subject_keywords: []
  attachment_types: []
  input_types: ['email']
routing_rule:
  destination_type: stream
  destination: "tier2 stream-log"
  destination_resolver: null
  process: "digest"
  default_assignee: ""
confidence_score: 0.85
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
tags: ['onboarding', 'newsletter', 'auto-generated']
---

## Routing Logic
Route newsletter senders to stream log for daily digest.

## Exceptions
None defined yet.
