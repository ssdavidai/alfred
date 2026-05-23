---
type: instinct
name: route-inner-circle-priority
status: active
description: "Prioritize inner-circle contacts for immediate triage"
input_patterns:
  sender_domains: ['nakmuaynation.com', 'boardy.ai', 'wise.com', 'oliveandbrown.hu', 'agent.szabostuban.com', 'substack.com', 'stylersgroup.com', 'github.com', 'neoterragroup.com', 'mailgun.zendesk.com']
  subject_keywords: []
  attachment_types: []
  input_types: ['email']
routing_rule:
  destination_type: triage
  destination: "priority, immediate triage"
  destination_resolver: null
  process: "urgent-triage"
  default_assignee: ""
confidence_score: 0.95
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
tags: ['onboarding', 'inner-circle', 'auto-generated']
---

## Routing Logic
Route inner-circle contacts to immediate triage queue.

## Exceptions
None defined yet.
