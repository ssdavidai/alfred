---
type: instinct
name: {{name}}
status: active
description: "{{description}}"
# Input patterns (structured)
input_patterns:
  sender_domains: {{sender_domains}}
  subject_keywords: {{subject_keywords}}
  attachment_types: {{attachment_types}}
  input_types: {{input_types}}
# Routing rule (structured, supports dynamic resolution)
routing_rule:
  destination_type: {{destination_type}}
  destination: "{{destination}}"
  destination_resolver: {{destination_resolver}}
  process: "{{process}}"
  default_assignee: "{{default_assignee}}"
# Stats
confidence_score: {{confidence_score}}
observation_count: {{observation_count}}
observations: {{observations}}
last_reflection: {{last_reflection}}
# Matching config
matching_weights:
  domain: 0.30
  keywords: 0.30
  input_type: 0.15
  attachment: 0.15
  tags: 0.10
discretion_threshold: {{discretion_threshold}}
# Lifecycle
created: {{created}}
updated: {{updated}}
tags: {{tags}}
---

## Routing Logic
{{routing_logic}}

## Exceptions
{{exceptions}}
