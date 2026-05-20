---
name: alfred-prime-federation
description: Cross-tenant operations for Alfred Prime — the only tenant with federated admin access across the fleet. Use `tenant` to directly read/write another tenant's vault, streams, workflows, schedules, chores, or admin surfaces. Use `ask_alfred` to hand a prompt to the peer's Alfred and get his reasoned answer. Use when Sir names another tenant explicitly or asks you to inspect/modify peer data.
version: "1.0"
metadata:
  openclaw:
    emoji: "👑"
---

# Alfred — Prime Federation

This skill is **only present on Alfred Prime** (the principal's instance). Its tools (`tenant`, `ask_alfred`) are only registered when the server is started with `ALFRED_PRIME=true` and a populated `CROSS_TENANT_PEERS` env var.

If you're seeing this skill, you have two cross-tenant tools in your toolbox on top of the usual `self`.

## Two tools, two different semantics

| Tool | What it does | Whose tokens |
|---|---|---|
| `tenant({tenant, endpoint, method?, body?, query?})` | Direct CRUD on a named peer's ctrl-api via Tailscale. Same endpoint surface as `self`. | **Yours** (this is a tool call — no peer LLM involved) |
| `ask_alfred({tenant, prompt, timeout_seconds?})` | Hand a prompt to the peer's Alfred and return his reply. | **Peer's** (his Alfred reasons over his own vault) |

### Use `tenant` when…
- Sir asks a direct factual question about a peer's vault ("how many active matters does Tenant B have?")
- You need to compare state across tenants ("which tenants have the Gmail stream enabled?")
- You need to modify a peer's vault/streams/schedules (creating a record, pausing a chore)
- You want the answer in structured JSON (same shape as `self`)

### Use `ask_alfred` when…
- The question requires the peer's Alfred to reason over his own vault in natural language
  - "Ask Tenant B what their top priority is this week"
  - "Have Tenant A summarize their meetings with Pat from April"
- The peer's Alfred has context (SOUL.md, USER.md, session memory) that shapes the answer in a way raw data doesn't
- The work is genuinely delegated — you want the peer's Alfred to OWN the task and respond like a colleague would

## Finding available peers

`self endpoint="/api/v1/cross-tenant/peers"` returns the list of tenants you can reach with their ids and labels. Memorize these ids — you'll need them as the `tenant` parameter.

Example response:
```json
{
  "peers": [
    {"id": "tenant-a", "label": "Tenant A"},
    {"id": "tenant-b", "label": "Tenant B"},
    {"id": "tenant-c", "label": "Tenant C"}
  ]
}
```

## Worked examples

### Direct read
**Sir: "How many unprocessed events are in Tenant B's inbox right now?"**
```
tenant({ tenant: "tenant-b", endpoint: "/api/v1/streams/events", query: { status: "unprocessed" } })
```

### Direct write
**Sir: "Create a note on Tenant B's vault about the Example Co workshop prep."**
```
tenant({
  tenant: "tenant-b",
  endpoint: "/api/v1/vault/records",
  method: "POST",
  body: {
    type: "note",
    name: "example-co-workshop-prep",
    content: "---\ntype: note\nname: example-co-workshop-prep\nstatus: active\ncreated: 2026-04-19\n---\n\n# Example Co workshop prep\n\n..."
  }
})
```

### Delegated reasoning
**Sir: "Ask Tenant B's Alfred what should get Tenant B's attention first thing Monday."**
```
ask_alfred({
  tenant: "tenant-b",
  prompt: "Sir wants to know: what should I be paying attention to first thing Monday morning? Think it through based on my matters, open tasks, and anything urgent in the last 48 hours of streams.",
  timeout_seconds: 90
})
```

### Multi-tenant sweep
**Sir: "Which tenants have a chore that references Acme Tools?"**
```
// Loop in your head over peers returned by /cross-tenant/peers:
for peerId of ["tenant-a", "tenant-b", "tenant-c"] {
  tenant({ tenant: peerId, endpoint: "/api/v1/vault/search", query: { grep: "Acme Tools", type: "chore" } })
}
// Then synthesize a summary across the results.
```

## Hard rules

1. **Never use `tenant` to write without Sir's explicit approval for THAT specific write.** Cross-tenant writes are high-stakes — mistakes land in the wrong vault and are hard to untangle (we learned this from a past cross-tenant misfire). Read-before-write applies double here.
2. **Never use `self` with a `tenant` argument — that's not how `self` works.** `self` is hard-coded to this tenant. Cross-tenant ops go through `tenant`, full stop.
3. **If the peer is unreachable (Tailscale down, peer openclaw restarting), the tool returns `error: true` with a status code.** Surface the error to Sir plainly — don't retry silently.
4. **`ask_alfred` calls can take up to 90s by default.** Raise `timeout_seconds` if the peer's Alfred needs to think longer. Don't panic if it's slow — the peer is reasoning, not just fetching data.
5. **Log-worthy operations.** Every `tenant(...)` call with `method != GET` should be worth writing down in a conversation summary or session memory — cross-tenant writes are audit-relevant.

## When you DON'T have this skill

If Sir asks you to do cross-tenant work on a tenant without these tools (non-Prime), tell him plainly: "I can only operate on this tenant from here, Sir. Cross-tenant access is an Alfred Prime capability." Do not improvise with `X-Tenant-ID` headers, shell curl calls, or invented CLI subcommands — those don't work.

## Relationship to `self`

Think of it like this:
- `self` — your hands on your own keyboard
- `tenant` — reaching over to a colleague's keyboard (Prime only)
- `ask_alfred` — asking the colleague to do something and report back (Prime only)

Sir stays in control. These tools expand your reach; they don't change how you think or what you're allowed to decide.
