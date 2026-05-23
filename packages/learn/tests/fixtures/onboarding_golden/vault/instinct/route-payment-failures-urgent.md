---
type: instinct
name: route-payment-failures-urgent
status: active
description: "Flag payment failures and declined transactions as urgent tasks"
input_patterns:
  sender_domains: ['firstbase.io', 'product.miro.com', 'slack.com', 'rayonapp.com', 'supabase.com']
  subject_keywords: ['failed', 'declined', 'overdue', 'past due', 'payment failed']
  attachment_types: []
  input_types: ['email']
routing_rule:
  destination_type: task
  destination: "urgent task"
  destination_resolver: null
  process: "urgent-review"
  default_assignee: ""
confidence_score: 0.8
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
tags: ['onboarding', 'financial', 'urgent', 'auto-generated']
---

## Routing Logic
Route payment failure notifications to urgent task queue.

## Exceptions
None defined yet.
