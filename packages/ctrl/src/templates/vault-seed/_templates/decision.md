---
type: decision
created: "{{date}}"
principal: principal # principal | alfred
source: "" # needs_attention | approval | judgment | to_do | desk_originated | …
source_record: ""
intent: "" # delegate | defer | done | take_mine | noise
note: null
state: open # open | scheduled | executing | completed | reversed
is_reversible: true
outcome_record: null
---

# Decision

A first-class record of a human action on the Desk. Every Delegate /
Defer / Delete / Do click becomes one of these. The desk action is
also mirrored into state.db `audit` (action_type='decision').
