---
name: alfred-skill-authoring
description: Create, edit, list, or delete user-authored SKILL.md files on Sir's request — the conversational shape of teaching yourself a new behaviour. Use whenever Sir says "make that a skill", "set up a skill for X", "edit my <slug> skill", "delete the <slug> skill", or you've spotted a recurring pattern in his behaviour and want to propose codifying it. Companion to `alfred-chore-authoring` (which sets up recurring Temporal workflows). A skill is what you read when you're invoked; a chore is when you fire on a schedule.
version: "1.0"
metadata:
  openclaw:
    emoji: "📜"
---

# Alfred — Skill Authoring

A SKILL.md is the contract that tells future-you (or a subagent on the workers gateway) how to handle a particular kind of request. Sir adds skills two ways: he asks you to write one, or you propose one when you've noticed a pattern.

This skill teaches the API, the shape of a good SKILL.md, the "when not to" rules, and the conversational loop with Sir.

## When to propose a new skill

Wait for the third time. If Sir does the same shape of thing three times — forwards every Example Co invoice to his accountant, asks for a portfolio summary every Monday, drafts the same kind of "thanks for the intro" reply — surface it at a natural pause and ask:

> "Sir, that's the third Example Co invoice you've forwarded to Riley this month. Want me to make that a skill so I do it automatically?"

Don't propose mid-task. Don't propose on a single observation. Don't propose if there's already a platform skill (`alfred-*`) covering the area — extend it conversationally instead.

## When NOT to create a skill

- One-off requests ("just send Riley this one"). Do the thing, don't codify it.
- Anything that contradicts a platform skill. If Sir wants different email behaviour than `alfred-email-channel` describes, that's a conversation, not a skill override.
- Anything credential- or PII-bearing. Skills go to disk in plaintext and get read by every future agent invocation. No API keys, no full email addresses of third parties, no client account numbers.
- Behaviours that should be a chore (recurring on a schedule) — those go through `alfred-chore-authoring`. A skill teaches you HOW to do something; a chore is WHEN to do it. Many chores reference a skill; few skills need a chore.

## Skill structure

Required frontmatter:

```yaml
---
name: user-onboarding-emails           # Must match the slug exactly. user- prefix mandatory.
description: <one sentence — when this skill applies and what it does>
version: "1.0"
metadata:
  openclaw:
    emoji: "📧"                        # Optional but nice; openclaw uses it in tool listings.
---
```

Body shape (4 sections, in order):

1. **One-paragraph intent.** What this skill teaches you to do. Who it's for (almost always "Sir asked me to…"). When you'd reach for it.
2. **Gather** — the inputs. List the `self()` and `composio_execute` calls you'd make to fetch context. Be concrete: endpoints, query params, why each one.
3. **Reason / decide** — the rules. If/then logic. Anti-patterns. Things to deliberately NOT do.
4. **Deliver** — how the output reaches Sir or the third party. Voice / tone notes if relevant. The "your reply IS the delivery" rule if applicable.

End with one or two **worked examples**: "Sir said X → you fetch Y → you reply Z."

Aim for 80-200 lines. Skills longer than ~250 lines are usually two skills wearing one hat — split.

## The user- prefix rule

Every user-authored skill name MUST start with `user-`. The `alfred-` prefix is reserved for two things: platform-shipped skills (this one, `alfred-chore-authoring`, `alfred-email-channel`, etc.) and Composio integration skills (`alfred-composio-gmail`, etc., auto-generated on connect). The endpoint will reject anything else.

Good slugs: `user-portfolio-monday-summary`, `user-example-co-forward`, `user-investor-update-draft`.
Bad slugs: `alfred-investor-update`, `Investor_Update`, `investor`.

## The endpoints

All under `/api/v1/skills`, called via the `self` MCP tool.

### List

```
self({endpoint: "/api/v1/skills"})
```

Returns `{skills: [{name, kind, size_bytes, updated_at}, ...]}`. `kind` is one of `platform`, `auto-generated`, `user`. Filter to `kind === "user"` to show Sir his own skills:

> "You have 4 skills authored: `user-portfolio-monday-summary`, `user-example-co-forward`, `user-investor-update-draft`, `user-thank-intro-reply`."

### Read

```
self({endpoint: "/api/v1/skills/user-example-co-forward"})
```

Returns `{name, kind, size_bytes, updated_at, content, frontmatter}`. Use this before a PUT — read, modify, write back the whole content.

### Create

```
self({
  endpoint: "/api/v1/skills",
  method: "POST",
  body: {
    name: "user-example-co-forward",
    content: "---\nname: user-example-co-forward\ndescription: ...\n---\n\n# ...\n"
  }
})
```

Returns `201 {name, kind: "user", deployed: ["openclaw", "openclaw-workers"], reload_required: false}`.

The endpoint validates:
- Name shape (lowercase kebab, must start with `user-`).
- Content has frontmatter with `name:` and `description:`.
- Content is ≤ 50 KB.
- No existing skill with that name (use PUT to update).

If validation fails you'll get a 400 with `error.message` pointing at the problem. Read it, fix, retry.

The skill is mirrored to both `openclaw` and `openclaw-workers` automatically. The openclaw gateway watches the skills directory and hot-reloads — no restart, no waiting. The next agent invocation will see your new skill.

### Update

```
self({
  endpoint: "/api/v1/skills/user-example-co-forward",
  method: "PUT",
  body: {content: "<full new content>"}
})
```

Pattern: GET the current content, hand it to Sir for review, apply his edits, PUT the result. Don't try to PATCH partial sections — the API takes a full content blob.

PUT will refuse with 403 if the name starts with `alfred-` (platform-protected) or `alfred-composio-` (auto-generated, would be overwritten anyway).

### Delete

```
self({
  endpoint: "/api/v1/skills/user-thank-intro-reply",
  method: "DELETE"
})
```

Same protection as PUT — only user skills may be deleted.

## The conversational loop

When Sir says "make that a skill" or you propose one and he says yes:

1. **Sketch the shape out loud first.** "I'd call it `user-example-co-forward`. It would trigger when an email from `*@example.com` arrives, draft a forward to Riley at `accountant@example.com` with the subject `Example Co invoice — please process`, and quote the body. Sound right?"
2. **Wait for refinements.** Sir might add: "Also tag it in the vault as a Example Co matter." Roll those in.
3. **Draft the SKILL.md privately.** Don't paste 200 lines into the chat unless he asks to see them. Show him the frontmatter + section headings + one worked example so he can see the structure.
4. **POST when he confirms.** Read the response. If 201, tell him: "Done — `user-example-co-forward` is live. Next Example Co email will go to Riley." If 4xx, fix the validation error and retry without bothering him.
5. **Don't restart anything.** The hot-reload is automatic. If Sir asks "do I need to restart?", say no.

## When Sir is editing

> "Edit my `user-example-co-forward` skill — also CC Devon when the invoice is over €10k."

GET the skill, find the relevant section, modify it (add an `if invoice_amount > 10000: cc Devon@…` clause to the Reason/decide section), PUT the new content. Confirm: "Updated. Now CCing Devon when the invoice is over €10k."

## Anti-patterns

- **Don't write a SKILL.md that just says "use `composio_execute`".** That's already in the platform tools docs. The skill should encode Sir's specific judgement: WHICH composio actions, with WHAT args, in WHAT order, under WHAT conditions.
- **Don't include credentials or PII.** No API keys, no Sir's account numbers, no third-party email addresses unless they're already in Sir's vault as a person record. If you need a credential, fetch it via `self({endpoint: "/api/v1/credentials/..."})` at runtime instead.
- **Don't auto-create skills without asking.** Pattern recognition is your job; codification needs Sir's nod. The exception is when Sir explicitly delegates ("if you spot anything worth automating, just do it" — even then, name what you did at the next checkpoint).
- **Don't write a skill that contradicts a platform skill.** If `alfred-email-channel` says reply with "Sir" and your `user-` skill says reply with the recipient's first name, the platform skill wins on conflict — and Sir will see weird behaviour. Compose / extend instead.

## Worked example

**Sir:** "I want every Friday to ping me with what's open across my matters."

That's a chore (it's recurring), not a skill. Punt to `alfred-chore-authoring` and pattern A.

**Sir:** "Make a skill for handling Example Co invoice forwards."

That's a skill (a behavioural contract that fires on demand or as part of a chore).

```yaml
---
name: user-example-co-forward
description: Forward Example Co invoices to Riley at the accountant firm with a structured subject line. Use when an email from any *@example.com address contains an attachment or "factura" / "invoice" in the subject.
version: "1.0"
metadata:
  openclaw:
    emoji: "🧾"
---

# User — Example Co invoice forward

When a Example Co email arrives that looks like an invoice, forward it to Riley so it lands in the accountant firm's intake without Sir's involvement.

## Gather

- The triggering email — already in your context if you were spawned by `alfred-email-channel`.
- Riley's address — `accountant@example.com`. (Cached in person/Riley-Reyes.md; verify with `self({endpoint: "/api/v1/vault/person/klara-reyes"})` if missing.)

## Reason

- "Looks like an invoice" = subject contains `factura`, `invoice`, or `Rechnung`, OR the email has a PDF attachment whose filename contains `factura` / `invoice`.
- If the invoice is over €10,000, also CC Devon at `marco@example.com` (Riley's senior).
- Skip if the email already has Riley CC'd.

## Deliver

Use `self({endpoint: "/api/v1/email/forward", method: "POST", body: {message_id: "<id>", to: "accountant@example.com", subject: "Example Co invoice — please process", body: "Riley — forwarding for processing. Sir."}})`. Don't add commentary. Don't tell Sir each time; this is fire-and-forget.

## Worked example

Inbound email: from `facturacion@example.com`, subject `Factura 2026-Q1`, PDF attached.
→ POST `/api/v1/email/forward` to Riley with the structured subject. Done. No notification to Sir.

If the PDF amount is €18,500: same forward, but CC `marco@example.com`.
```

POST that. Confirm "Done — `user-example-co-forward` is live, hot-reloaded into both gateways." Move on.
