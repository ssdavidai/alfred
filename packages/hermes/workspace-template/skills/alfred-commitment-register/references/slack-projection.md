# Projecting a register to Slack

Only relevant when the matter opts in with `projection: slack:<channel>`. The
default projection is a vault note and needs none of this.

Slack is opt-in rather than default because a default capability must work on a
tenant with no integrations at all.

## Before every write: destination safety preflight

Inspect the Canvas metadata and its **complete** current binding — the whole
`groups` / `channels` / private-share set, not just the intended listing entry.

A Canvas named as a private projection is unsafe to update if the same file is
also shared into a client-facing or forbidden destination: changing the file
mutates what that audience sees, without any new message being posted.

If an intended private Canvas is also visible from a forbidden destination:

1. Do not write, replace or refresh it. The intended binding does not override
   the forbidden share.
2. Continue the bounded evidence reconciliation and record read/write
   verification — those surfaces are still safe.
3. Read the Canvas back and record its exact ID, every bound channel ID, the
   permalink, and the unchanged body and marker, so the no-write claim is
   independently verified.
4. Report the projection as **incomplete — blocked by destination safety**.
   This is distinct from `Source refresh degraded`: the sweep may be complete
   even though delivery is unsafe.
5. Do not remove shares, recreate the Canvas or migrate bindings during a
   routine reconciliation. That needs separate authorisation.
6. Treat the unsafe cross-share as a reportable blocker — not degradation, and
   not a no-change/silent condition.
7. Structural defects found in the blocked artifact (stale headings, missing
   IDs, duplicate H1s, absent markers) must be **recorded but not repaired**
   while the forbidden share remains. Destination safety outranks format
   repair.

## Canvas helper and read-back

Where a tenant has the Slack Canvas helper installed, it uses **positional**
arguments, not GNU-style flags:

```bash
python3 "$HERMES_HOME/bin/slack_canvas.py" create "<title>" "<markdown>"
python3 "$HERMES_HOME/bin/slack_canvas.py" channel-create <channel_id> "<markdown>"
python3 "$HERMES_HOME/bin/slack_canvas.py" read <canvas_id>
python3 "$HERMES_HOME/bin/slack_canvas.py" list 500
```

Do not assume a remembered `--channel-id`, `--title`, `--markdown-file`,
`download` or `--help` interface. Read the script's dispatcher before a
side-effecting call: **a malformed positional call can succeed while creating
the wrong standalone Canvas.**

Authenticated read-back:

1. Fetch `files.info` for the Canvas ID.
2. Download `url_private_download` with the bot token as a bearer credential.
3. Parse the rendered output and verify the title, required sections, first and
   highest IDs, the marker exactly once, and the footer.
4. Verify channel attachment separately with `list` — `files.info.channels` can
   be empty for a correctly channel-bound Canvas.

Never infer the title from the Slack file title: a channel-created Canvas may
stay `Untitled` while its rendered H1 is correct.

## Renderer-owned headings

Slack may inject its own outer H1 while preserving the document's H1. Do not
require exactly one H1 in the rendered output. Require instead:

- the intended document H1 present exactly once;
- no conflicting register H1;
- required sections and marker verify;
- channel binding verifies separately.

An extra generic wrapper H1 is renderer chrome, not corruption.

## Migrating to another channel

Migration is a coordinated binding change, not a copied Canvas. Record old and
new values for: channel ID and name; Canvas ID and permalink; policy note and
maintenance commitment; the reconciliation job's delivery target **and its
prompt**; any generic Canvas-maintenance registry; and every other scheduled
job that could refresh the register.

Then:

1. Write the complete projection to the new destination and verify binding,
   heading, first/highest IDs, sections and marker.
2. Update the matter's `commitment_register` block, the policy note and the
   maintenance commitment with the new identity, and put the retired
   destination on an explicit do-not-read/write/deliver boundary.
3. Rebind the scheduled job's delivery target *and* its prompt. The prompt must
   name the new destination and forbid the old one.
4. Trigger one run. An acknowledgement is not proof — require a newer
   `last_run_at`, a successful status and no delivery error.
5. Confirm the new Canvas advanced and **the retired Canvas did not**.
6. Preserve the retired Canvas. Deleting or archiving needs separate
   authorisation.

Common pitfalls: updating the channel ID but leaving the old Canvas ID;
changing delivery while the prompt still names the retired Canvas; forgetting a
generic dashboard job that can later overwrite the old destination; blindly
retrying after a timeout or 429 without first checking the marker, because the
write may already have landed.
