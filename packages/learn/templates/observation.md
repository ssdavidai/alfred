---
type: observation
created: {{created}}
status: unprocessed
# Input context
input_ref: "{{input_ref}}"
input_type: {{input_type}}
input_source: {{input_source}}
# Routing decision (structured)
routing_decision:
  destination: "{{routing_destination}}"
  process: "{{routing_process}}"
  assigned_to: "{{routing_assigned_to}}"
# Reasoning
reasoning: "{{reasoning}}"
considered_alternatives: {{considered_alternatives}}
# Signals for matching
signals:
  domain_patterns: {{domain_patterns}}
  keyword_patterns: {{keyword_patterns}}
  input_types: {{input_types}}
  attachment_patterns: {{attachment_patterns}}
# Provenance
confidence: {{confidence}}
routed_by: {{routed_by}}
source: {{source}}
source_session: "{{source_session}}"
created_by: "{{created_by}}"
tags: {{tags}}
---
