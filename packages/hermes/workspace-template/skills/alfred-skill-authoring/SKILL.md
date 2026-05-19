---
name: alfred-skill-authoring
description: Create, edit, list, or delete user-authored SKILL.md files on Sir's request — the conversational shape of teaching yourself a new behaviour. Use whenever Sir says "make that a skill", "set up a skill for X", "edit my <slug> skill", "delete the <slug> skill", or you've spotted a recurring pattern in his behaviour and want to propose codifying it. Companion to `alfred-chore-authoring` (which sets up recurring Temporal workflows). A skill is what you read when you're invoked; a chore is when you fire on a schedule.
version: "2.0"
metadata:
  openclaw:
    emoji: "📜"
---

# Alfred — Skill Authoring

A SKILL.md is the contract that tells future-you (or a subagent on the workers profile) how to handle a particular kind of request. Sir adds skills two ways: he asks you to write one, or you propose one when you've noticed a pattern.

This skill teaches how Hermes manages skills natively, the shape of a good SKILL.md, the "when not to" rules, and the conversational loop with Sir.

## How skills work in Hermes

Hermes owns skill management end to end. There is no ctrl-api skills endpoint
and nothing to hot-reload by hand:

- **Storage.** Every skill is a directory containing a `SKILL.md` file, living
  in this profile's skills directory — `${HERMES_HOME}/skills/<slug>/SKILL.md`
  (for the split-profile layout, `${HERMES_HOME}/profiles/<profile>/skills/`).
  That is the canonical, native path Hermes discovers; nothing else is needed.
- **Discovery + loading.** Hermes scans the skills directory, does
  progressive-disclosure loading (the frontmatter `description` is what it
  reads first to decide relevance), and picks up new or changed skill files
  on its own. You do not restart anything and you do not call a reload trigger.
- **The `hermes skills` CLI.** Use it through the `terminal` tool to list and
  inspect skills: `hermes skills list`, `hermes skills show <slug>`. The CLI
  reads the same native directory.
- **Writing skills.** Use the `file` tool to create or edit a
  `SKILL.md` directly under the skills directory. Hermes hot-reloads it; the
  next invocation sees it.

The platform skills (`alfred-*`) and the auto-generated Composio skills
(`alfred-composio-*`) are placed into the skills directory by the init
container on first boot and are managed there — leave those alone (see the
"When NOT to create a skill" rules below). User-authored skills are yours and
Sir's to create, edit, and delete.

## When to propose a new skill

Wait for the third time. If Sir does the same shape of thing three times — forwards every Example Co invoice to his accountant, asks for a portfolio summary every Monday, drafts the same kind of "thanks for the intro" reply — surface it at a natural pause and ask:

> "Sir, that's the third Example Co invoice you've forwarded to Riley this month. Want me to make that a skill so I do it automatically?"

Don't propose mid-task. Don't propose on a single observation. Don't propose if there's already a platform skill (`alfred-*`) covering the area — extend it conversationally instead.

## When NOT to create a skill

- One-off requests ("just send Riley this one"). Do the thing, don't codify it.
- Anything that contradicts a platform skill. If Sir wants different email behaviour than `alfred-email-channel` describes, that's a conversation, not a skill override.
- Anything credential- or PII-bearing. Skills go to disk in plaintext and get read by every future agent invocation. No API keys, no full email addresses of third parties, no client account numbers.
- Behaviours that should be a chore (recurring on a schedule) — those go through `alfred-chore-authoring`. A skill teaches you HOW to do something; a chore is WHEN to do it. Many chores reference a skill; few skills need a chore.
- **Never edit or delete a platform (`alfred-*`) or Composio (`alfred-composio-*`) skill.** Those are init-container-managed; your changes would be overwritten on the next boot and you'd be fighting the platform. Extend behaviour conversationally instead.

## Skill structure

Required frontmatter:

```yaml
---
name: user-onboarding-emails           # Must match the slug exactly. user- prefix mandatory.
description: <one sentence — when this skill applies and what it does>
version: "1.0"
metadata:
  openclaw:
    emoji: "📧"                        # Optional but nice; shown in skill listings.
---
```

The `description` is load-bearing: it is what Hermes reads during
progressive-disclosure loading to decide whether the skill is relevant. Make
it a precise one-sentence "when X happens, do Y" so Hermes surfaces it at the
right time and skips it otherwise.

Body shape (4 sections, in order):

1. **One-paragraph intent.** What this skill teaches you to do. Who it's for (almost always "Sir asked me to…"). When you'd reach for it.
2. **Gather** — the inputs. List the `self()` and `composio_execute` calls you'd make to fetch context. Be concrete: endpoints, query params, why each one.
3. **Reason / decide** — the rules. If/then logic. Anti-patterns. Things to deliberately NOT do.
4. **Deliver** — how the output reaches Sir or the third party. Voice / tone notes if relevant. The "your reply IS the delivery" rule if applicable.

End with one or two **worked examples**: "Sir said X → you fetch Y → you reply Z."

Aim for 80-200 lines. Skills longer than ~250 lines are usually two skills wearing one hat — split.

## The user- prefix rule

Every user-authored skill name (and its directory slug) MUST start with `user-`. The `alfred-` prefix is reserved for two things: platform-shipped skills (this one, `alfred-chore-authoring`, `alfred-email-channel`, etc.) and Composio integration skills (`alfred-composio-gmail`, etc., auto-generated on connect). Keeping your skills in the `user-` namespace is what stops them colliding with — or being overwritten by — anything the init container manages.

Good slugs: `user-portfolio-monday-summary`, `user-example-co-forward`, `user-investor-update-draft`.
Bad slugs: `alfred-investor-update`, `Investor_Update`, `investor`.

The directory name and the frontmatter `name:` must match the slug exactly.

## Working with skills natively

### List

Through the `terminal` tool:

```
hermes skills list
```

Skills whose slug starts with `user-` are the ones Sir authored. Filter to those when you show him his own:

> "You have 4 skills authored: `user-portfolio-monday-summary`, `user-example-co-forward`, `user-investor-update-draft`, `user-thank-intro-reply`."

### Read

```
hermes skills show user-example-co-forward
```

or read the file directly with the `file` tool from
`${HERMES_HOME}/skills/user-example-co-forward/SKILL.md`. Read the whole file
before you edit it — you rewrite the full content.

### Create

Use the `file` tool to write the `SKILL.md` into a new directory under the
skills path:

```
${HERMES_HOME}/skills/user-example-co-forward/SKILL.md
```

Write the full file — frontmatter (`name:`, `description:`, `version:`) plus
the four body sections. Before you write, sanity-check yourself:

- The directory slug starts with `user-` and matches the frontmatter `name:`.
- The slug is lowercase kebab-case (letters, digits, single dashes).
- The frontmatter has a non-empty `name:` and `description:`.
- No existing skill already uses that slug (`hermes skills list` first; if it
  exists, you're editing, not creating).
- The body is well under ~50 KB — a skill is a contract, not a data dump.

Once the file is on disk, Hermes discovers and loads it on its own. No
restart, no reload trigger — the next agent invocation sees the new skill.

### Update

`hermes skills show <slug>` (or read the file) to get the current content,
hand it to Sir for review, apply his edits, then write the full new content
back to the same `SKILL.md` with the `file` tool. Don't try to patch partial
sections in your head — pull the whole file, edit it, write the whole file.

Refuse to edit any `alfred-*` or `alfred-composio-*` skill — those are
platform/auto-generated and init-container-managed; your edits would be
overwritten. Extend behaviour conversationally instead.

### Delete

Remove the skill's directory under the skills path with the `terminal` tool:

```
rm -r ${HERMES_HOME}/skills/user-thank-intro-reply
```

Only ever delete `user-*` skills. Never delete an `alfred-*` or
`alfred-composio-*` skill.

## The conversational loop

When Sir says "make that a skill" or you propose one and he says yes:

1. **Sketch the shape out loud first.** "I'd call it `user-example-co-forward`. It would trigger when an email from `*@example.com` arrives, draft a forward to Riley at `accountant@example.com` with the subject `Example Co invoice — please process`, and quote the body. Sound right?"
2. **Wait for refinements.** Sir might add: "Also tag it in the vault as a Example Co matter." Roll those in.
3. **Draft the SKILL.md privately.** Don't paste 200 lines into the chat unless he asks to see them. Show him the frontmatter + section headings + one worked example so he can see the structure.
4. **Write the file when he confirms.** Then confirm to Sir: "Done — `user-example-co-forward` is live. Next Example Co email will go to Riley." If you got the slug or frontmatter shape wrong, fix it and rewrite without bothering him.
5. **Don't restart anything.** Hermes hot-reloads the skills directory on its own. If Sir asks "do I need to restart?", say no.

## When Sir is editing

> "Edit my `user-example-co-forward` skill — also CC Devon when the invoice is over €10k."

Read the skill, find the relevant section, modify it (add an `if invoice_amount > 10000: cc Devon@…` clause to the Reason/decide section), write the full new content back. Confirm: "Updated. Now CCing Devon when the invoice is over €10k."

## Anti-patterns

- **Don't write a SKILL.md that just says "use `composio_execute`".** That's already in the platform tools docs. The skill should encode Sir's specific judgement: WHICH composio actions, with WHAT args, in WHAT order, under WHAT conditions.
- **Don't include credentials or PII.** No API keys, no Sir's account numbers, no third-party email addresses unless they're already in Sir's vault as a person record. If you need a credential, fetch it via `self({endpoint: "/api/v1/credentials/..."})` at runtime instead.
- **Don't auto-create skills without asking.** Pattern recognition is your job; codification needs Sir's nod. The exception is when Sir explicitly delegates ("if you spot anything worth automating, just do it" — even then, name what you did at the next checkpoint).
- **Don't write a skill that contradicts a platform skill.** If `alfred-email-channel` says reply with "Sir" and your `user-` skill says reply with the recipient's first name, the platform skill wins on conflict — and Sir will see weird behaviour. Compose / extend instead.
- **Don't touch `alfred-*` skills.** They are init-container-managed. Edits and deletions are reverted on the next boot.

## Worked example

**Sir:** "I want every Friday to ping me with what's open across my matters."

That's a chore (it's recurring), not a skill. Punt to `alfred-chore-authoring` and pattern A.

**Sir:** "Make a skill for handling Example Co invoice forwards."

That's a skill (a behavioural contract that fires on demand or as part of a chore).

Write `${HERMES_HOME}/skills/user-example-co-forward/SKILL.md` with:

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

Write that file. Hermes picks it up. Confirm "Done — `user-example-co-forward` is live." Move on.
