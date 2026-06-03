---
name: alfred-paperclip-bootstrap
description: Turn an attached org-design document (a company brief, an "AI staff" plan, a founder's "here's who I want on the team" note) into a real Paperclip company with its agents and a principal login. Use when Sir attaches such a document and says "set this up in Paperclip", "build this company", "spin up these agents", or "bootstrap a Paperclip org from this". Confirm-first: derive the structure, show it, and create NOTHING until Sir says yes.
version: "1.0"
metadata:
  openclaw:
    emoji: "🏢"
---

# Alfred — Paperclip company bootstrap

When Sir hands you a document describing a company and the staff he wants — a
founder's brief, an org chart, an "AI team" plan — this skill turns that prose
into a live Paperclip company: the company itself, one Paperclip agent per role
(all running on Hermes locally), and a verified principal login Sir can use.

This is a **confirm-first** flow. You read the document, derive a structured org
spec, **show Sir the spec, and stop**. You create nothing in Paperclip until he
explicitly approves. A company plus its agents is real, billable, named
infrastructure — never conjure it from an unconfirmed reading of a document.

## Gather

1. **Read the attached document in full.** It's the source of truth for the
   org. Pull from it:
   - The **company**: a name and a one- or two-sentence description (its goal /
     mandate). If the doc names the company, use that name verbatim; if it only
     describes the venture, propose a clean name and flag it as your suggestion.
   - The **principal**: the human who owns this company — Sir, unless the
     document clearly names someone else. You need an `email` and a `name` for
     the login. If the doc doesn't give an email, ask Sir for the one he wants
     to log in with rather than guessing.
   - The **agents**: every role the document asks for. For each, derive a
     `name`, a `role` (a short lowercase token — `ceo`, `engineer`,
     `marketing`, `ops`, …), a human `title`, and a one-line `capabilities`
     summary of what that agent is responsible for. By convention the **first
     agent is the CEO** (`role: "ceo"`) — if the document describes a leader,
     map them to it; if it doesn't, propose a CEO agent so the company has a
     head.

2. **Assemble the C3 org spec.** Shape it exactly like this — this is the
   structure the rest of the flow consumes:

   ```json
   {
     "company":   { "name": "Acme Robotics", "description": "Builds warehouse pick-and-place arms." },
     "principal": { "email": "sir@example.com", "name": "Sir" },
     "agents": [
       { "name": "Ada",  "role": "ceo",       "title": "Chief Executive",   "capabilities": "Sets direction, approves budgets, fields the board." },
       { "name": "Bee",  "role": "engineer",  "title": "Lead Engineer",     "capabilities": "Owns the firmware and control stack." },
       { "name": "Cleo", "role": "marketing", "title": "Head of Marketing", "capabilities": "Owns positioning, launches, and demand gen." }
     ]
   }
   ```

   Every agent is created **`hermes_local`** — they run on this Hermes instance,
   not as external HTTP adapters. You don't set the adapter; the ctrl-api admin
   route forces it. Don't surface adapter choice to Sir.

## Reason / decide

- **Confirm before you touch anything.** After you've derived the spec, present
  it to Sir in plain language and **STOP**. Make NO tool calls yet — not even a
  read. Show him:
  - the company name + description,
  - the principal email the login will be tied to,
  - the full agent roster (name — title — role — what they do), CEO first.

  Then ask, explicitly: *"Shall I create this in Paperclip?"*

- **Wait for an explicit yes.** "Looks right", "go ahead", "yes, build it" — a
  clear approval. Anything ambiguous is not a yes; ask again. A document
  attachment alone is **not** consent to create.

- **On "no" or edits**, revise the spec and re-present it. Sir might rename the
  company, drop an agent, add a "finance" role, or change the principal email.
  Roll the changes in, show the updated spec, and ask again. **Create nothing
  until an approved spec is on the table.** Loop here as many times as it takes.

- **Idempotency is handled for you.** The admin routes are idempotent by name —
  re-running an approved bootstrap won't duplicate the company, the agents, or
  the user. If a create returns "already exists", that's fine; carry on.

- **Don't put secrets in the spec or in chat.** The principal's generated
  password comes back from the register step — relay it to Sir once, over the
  channel he's on, and don't echo it into any vault record or comment.

- **Reusing an existing board login.** The principal may already have a
  Paperclip account on this tenant (a previous bootstrap, or a login the seed
  flow created). When you present the spec, if you have reason to believe the
  principal email already exists — or Sir mentions an account he already signs
  in with — **offer to reuse it** rather than minting a fresh one: *"You already
  have a Paperclip login for that email — I'll just grant it access to the new
  company instead of creating a new account. Good?"* On yes, **skip the register
  step** in Deliver and go straight to the access grant (step 4) with that
  email. `paperclip_register_user` is idempotent anyway — if you do call it and
  it returns `created:false`, treat that as "reuse the existing login" and carry
  on to the grant; never present a password you don't have.

## Deliver

Only after Sir's explicit yes, run the creation sequence in this order. Each
tool name below is exact — call them as named:

1. **Create the company.**
   `paperclip_create_company({ name, description })` — from `company`.
   Keep the returned `companyId`; every later call needs it.

2. **Create each agent**, in roster order (CEO first).
   For each entry in `agents`:
   `paperclip_create_agent({ companyId, name, role, title, capabilities })`.
   All land as `hermes_local` (forced server-side). Collect the returned
   `agentId` for each.

3. **Register the principal login** — *unless they already have one* (see
   "Reusing an existing board login" below). `paperclip_register_user({ email,
   name })` — from `principal`. Omit `password` to have a strong one generated
   and returned. The identity comes back verified (tenants have no mailer).
   Keep the returned `loginUrl` and the one-time `password`. If the response is
   `created:false` the account already existed — that's fine; you won't have a
   password to report (don't invent one), just point them at the `loginUrl`
   with their existing credentials.

4. **Grant the principal access to the company.** This is the step that makes
   the login actually *usable* — registering an account does NOT give it
   membership of the company you just created (that's owned by the system seed
   identity), so without this the principal signs in and sees "No company
   access".
   `paperclip_grant_company_access({ companyId, email })` — same `email` you
   registered. It adds an operator membership; it's additive (won't touch any
   other company the principal already belongs to) and idempotent
   (`alreadyMember:true` on a re-run is success, not an error). Do this for
   the principal even when they reused an existing login.

5. **Read back to confirm.**
   `paperclip_list_agents({ companyId })` and check the roster you intended is
   actually present. (Optionally `paperclip_list_companies({})` to confirm the
   company.)

6. **Report to Sir.** One clean summary:
   - the company (name + id),
   - the agents that now exist (name — title — role), from the read-back,
   - the login: the `loginUrl`, the principal email, and — only for a freshly
     created account — the generated password (once, plainly, with a "change it
     after first sign-in" nudge). For a reused login, just confirm they can now
     open the company with their existing credentials.

Don't narrate each call as you go — do the sequence, then report the result in
one message.

## Worked example

**Sir** attaches `acme-plan.md` ("I want to stand up Acme Robotics — a small AI
staff: a CEO, a lead engineer, and a head of marketing. Log me in as
sir@example.com.") and says *"set this up in Paperclip."*

→ You read the doc and derive the spec (the JSON above). You **don't** call any
tool yet. You reply:

> "Here's what I'd create in Paperclip:
> **Company** — *Acme Robotics*: builds warehouse pick-and-place arms.
> **Login** — sir@example.com.
> **Agents** — Ada (Chief Executive, ceo), Bee (Lead Engineer, engineer), Cleo
> (Head of Marketing, marketing).
> Shall I create this in Paperclip?"

**Sir:** "Yes — but call the company *Acme Pick* and add an ops agent, Dot."

→ You revise: company `Acme Pick`, add `{ name: "Dot", role: "ops", title:
"Operations", capabilities: "Keeps the floor running." }`, re-present the
updated spec, and ask again. Sir: "Perfect, go."

→ Now you run the sequence: `paperclip_create_company` → four
`paperclip_create_agent` calls (Ada, Bee, Cleo, Dot, CEO first) →
`paperclip_register_user` → `paperclip_grant_company_access({ companyId, email:
"sir@example.com" })` → `paperclip_list_agents`. Then:

> "Done. **Acme Pick** is live (4 agents: Ada — Chief Executive, Bee — Lead
> Engineer, Cleo — Head of Marketing, Dot — Operations). Log in at
> `https://paperclip.<DOMAIN>` as sir@example.com — temporary password
> `<generated>`; change it on first sign-in. You have access to the company,
> so it'll open straight to its inbox."

If Sir had said *"no, not yet"* at the first prompt, you'd have created nothing
and simply waited.
