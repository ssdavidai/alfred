---
type: instinct
name: ""
tier: confirming # asking | confirming | acting
status: active # active | paused | retired
created: "{{date}}"
trigger: "" # what pattern fires this instinct
action: "" # what Alfred does when it fires
discretion_threshold: 0.7 # [0,1] — gate for autonomous action
tags: []
related: []
---

# {{name}}

A learned rule for how Alfred should act. Promoted from an observed
pattern (state.db `observation`, kind=pattern_proposal) once the
principal adopts it.

## Trigger

When this instinct should fire.

## Action

What Alfred does — and at which tier (asking / confirming / acting).
