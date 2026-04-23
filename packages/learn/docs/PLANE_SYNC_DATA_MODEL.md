# Plane sync data model

Field-mapping reference for the vault ↔ Plane integration. All mapping
logic lives in `packages/learn/src/utils/plane_mapping.py` and
`packages/learn/src/activities/plane_sync.py`. If the table below
disagrees with code, code wins — patch the table.

## Vault matter → Plane project

Forward direction. See `sync_matter_to_plane` in
`packages/learn/src/activities/plane_sync.py`.

| Vault frontmatter field | Plane project field                  | Notes                                                                                                              |
|-------------------------|--------------------------------------|--------------------------------------------------------------------------------------------------------------------|
| `name` (or `title`)     | `name`                               | Passed through `_sanitize_plane_name` (see below). Max 255 chars. Empty falls back to `"Untitled matter"` on reverse. |
| `description`           | `description_text`                   | String; falls back to `description_preview` (first body bytes) on first sync so the Plane UI has non-empty text.   |
| slug (from file path)   | `identifier` = `_project_identifier_for_slug(slug)` | Uppercase, alphanumeric-only, ≤ 5 chars. Fallback `ALFRD` when the slug strips to nothing.                     |
| slug (same)             | `external_id` = `"alfred:<slug>"`    | Stamped on create only. Lets reverse-sync's guard #1 recognise loop-backs.                                        |
| slug (same)             | `external_source` = `"alfred"`       | Same purpose as `external_id`.                                                                                   |

Reverse direction (Plane project → vault matter) via
`plane_project_to_matter_patch`:

| Plane project field                              | Vault frontmatter field | Notes                                                                                       |
|--------------------------------------------------|-------------------------|---------------------------------------------------------------------------------------------|
| `name`                                           | `name`                  | Truncated to 255 chars; empty → `"Untitled matter"`.                                        |
| `description_text` / `description_html` / `description` | `description`   | First non-empty wins. Stringified; `None` → empty string.                                   |
| `is_archived` or `archived_at` truthy            | `status: "archived"`    | Otherwise `status: "active"`.                                                               |
| `id`                                             | `plane_project_id`      | So reverse-sync can resolve matter without scanning every vault record.                     |

Never touched by reverse-sync on a matter: `related_matters`,
`related_persons`, `related_orgs`, `related_projects`, `source_event`.
These are surveyor-owned fields and Plane has no business mirroring
them.

## Vault task → Plane issue

Forward direction. See `sync_task_to_plane` and
`vault_task_to_plane_update`.

| Vault frontmatter field           | Plane issue field                                          | Notes                                                                                           |
|-----------------------------------|------------------------------------------------------------|-------------------------------------------------------------------------------------------------|
| `name`                            | `name`                                                     | Passed through `_sanitize_plane_name`; ≤ 255 chars; empty falls back to slug then `"Untitled"`. |
| `description`                     | `description_html`                                         | Omitted entirely when empty — Plane 1.3.0 rejects `""` with 400 Invalid HTML.                  |
| `priority`                        | `priority`                                                 | Mapped via `VAULT_PRIORITY_TO_PLANE`. Unknown values → `"none"`.                                |
| `status`                          | `state` (project-scoped UUID resolved from `state_group`)  | Mapped via `VAULT_TASK_TO_PLANE_STATE_GROUP`. `state_group` is resolved to a real state UUID   |
|                                   |                                                            | through `PlaneClient.resolve_state_id(project_id, group)`.                                      |
| `status == "blocked"`             | adds label `blocked` (in addition to state `unstarted`)    | The `blocked` state isn't a Plane group, so we use a label to preserve the signal.             |
| `requires_approval: true`         | adds label `alfred-needs-approval`                         | Surfaces in Plane UI so a human can triage.                                                     |
| always                            | adds label `alfred-managed`                                | Alfred-owned issues are taggable in the Plane UI with one click.                                |
| slug (from file path)             | `external_id` = `"alfred:<slug>"`                          | Create only. Feeds guard #1.                                                                   |
| `matter` / `related_matter` / `related_matters[0]` | `project` (Plane UUID from forward `project_map`) | Resolved through `_resolve_task_matter`. If no match: routes to Inbox project (sentinel slug `__inbox__`). |

Reverse direction (Plane issue → vault task) via
`plane_issue_to_vault_patch`:

| Plane issue field                    | Vault frontmatter field | Notes                                                                                                                 |
|--------------------------------------|-------------------------|-----------------------------------------------------------------------------------------------------------------------|
| `name`                               | `name`                  | Passed through untouched.                                                                                             |
| `state_detail.group` or `state_group`| `status`                | Mapped via `PLANE_STATE_GROUP_TO_VAULT_TASK`. Label `blocked` wins — `status` forced to `"blocked"` when label present. |
| `priority`                           | `priority`              | Mapped via `PLANE_PRIORITY_TO_VAULT`. `"none"` → `None`.                                                              |
| `project` (Plane UUID)               | `matter` and `related_matters` | Reverse-sync looks up `plane_project_to_slug`; if found, patches both. Moving to Inbox sentinel clears both fields. |

Never touched by reverse-sync on a task: `related_persons`,
`related_orgs`, `related_projects`, `source_event`. Surveyor-owned, not
Plane's territory.

## Priority mapping

`VAULT_PRIORITY_TO_PLANE` and `PLANE_PRIORITY_TO_VAULT`:

| Vault    | Plane     |
|----------|-----------|
| `low`    | `low`     |
| `medium` | `medium`  |
| `high`   | `high`    |
| `urgent` | `urgent`  |
| `None`   | `"none"`  |

Round-trip stable: `urgent` → `urgent` → `urgent`.
`None` → `"none"` → `None`.

## Status / state mapping

`VAULT_TASK_TO_PLANE_STATE_GROUP`:

| Vault `status` | Plane state group | Extra signal                                 |
|----------------|-------------------|----------------------------------------------|
| `queued`       | `backlog`         |                                              |
| `todo`         | `unstarted`       |                                              |
| `active`       | `started`         |                                              |
| `blocked`      | `unstarted`       | + label `blocked`                            |
| `done`         | `completed`       |                                              |
| `cancelled`    | `cancelled`       |                                              |

`PLANE_STATE_GROUP_TO_VAULT_TASK`:

| Plane state group | Vault `status` | Notes                                          |
|-------------------|----------------|------------------------------------------------|
| `backlog`         | `queued`       |                                                |
| `unstarted`       | `todo`         | Unless label `blocked` is present → `blocked`. |
| `started`         | `active`       |                                                |
| `completed`       | `done`         |                                                |
| `cancelled`       | `cancelled`    |                                                |

Round-trip stable for every vault status except `blocked`. `blocked`
round-trips correctly only if the `blocked` label sticks through the
Plane write — which it does, because we emit it on every forward upsert
when the vault status is `blocked`.

## Label conventions

Plane label names are case-sensitive. Forward sync hyphenates to match
Plane UI convention (`alfred:managed` → `alfred-managed`).

| Plane label              | Emitted by                                                   | Meaning                                                                                           |
|--------------------------|--------------------------------------------------------------|---------------------------------------------------------------------------------------------------|
| `alfred-managed`         | Forward sync, every upsert, always                           | Alfred created or touched this issue. Humans can filter by label to see the Alfred surface area. |
| `alfred-needs-approval`  | Forward sync, when vault task has `requires_approval: true`  | A human approver needs to sign off; Alfred won't act until someone comments `@alfred go`.        |
| `blocked`                | Forward sync, when vault task `status == "blocked"`          | Stand-in for the missing "blocked" state group. Reverse-sync reads this label to set `status`.    |

Label-set reconciliation: forward sync always sends the FULL label list
(not a diff). Human-added labels are preserved only in the Plane UI —
reverse-sync reads them onto the vault task, but only the three above
round-trip back out. Adding `hotfix` to an issue in Plane won't sync
back to vault today.

## Slug conventions

A vault matter at `matter/client-acme.md` has slug `client-acme`. A task
at `task/ship-q3-preview.md` has slug `ship-q3-preview`. Tolerates
missing prefix and missing `.md` — see `_slug_from_path`.

### Plane project identifier

Plane requires each project to have a short uppercase identifier (used
as the prefix for issue numbers, e.g. `CLNT-42`). We derive it from the
slug:

```python
def _project_identifier_for_slug(slug: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9]", "", slug).upper()
    if not cleaned:
        cleaned = "ALFRD"
    return cleaned[:5]
```

Examples:

| Slug                                 | Plane identifier |
|--------------------------------------|------------------|
| `client-acme`                        | `CLIEN`          |
| `family-life-hannas-first-year`      | `FAMIL`          |
| `q3-preview`                         | `Q3PRE`          |
| `---`                                | `ALFRD`          |

Collisions are allowed on the Plane side — Plane itself de-duplicates
identifiers by appending numbers (`CLIEN`, `CLIEN1`, `CLIEN2`) when a
project with the same identifier already exists. The existing mapping
in `project_map` is the source of truth, not the identifier; don't
assume the identifier uniquely identifies an Alfred-owned project.

## Name sanitization

Plane 1.3.0 rejects `-`, `&`, `'`, `"` in project names with 400
`Project name cannot contain special characters`. `_sanitize_plane_name`
runs on every outbound name (matter and task), replacing rejected chars
and collapsing whitespace:

```python
_PLANE_NAME_REJECT_RE = re.compile(r"[-&]+")

def _sanitize_plane_name(raw: str) -> str:
    if not raw:
        return "Untitled"
    cleaned = _PLANE_NAME_REJECT_RE.sub(" ", raw).replace("'", "").replace('"', "")
    cleaned = " ".join(cleaned.split()).strip()
    return cleaned or "Untitled"
```

Worked examples:

| Vault `name`                           | Plane project / issue `name`        |
|----------------------------------------|-------------------------------------|
| `Family Life & Hanna's First Year`     | `Family Life  Hannas First Year`    |
| `Client Acme - onboarding`             | `Client Acme  onboarding`           |
| `Don't do this`                        | `Dont do this`                      |
| `-----`                                | `Untitled`                          |

This is lossy. Reverse-sync does NOT try to un-sanitize — the vault
keeps the clean name, Plane keeps the sanitized name, and they drift.
If you ever want exact names, render them into `description_text`
instead (it's not sanitised).

## `external_id` origin stamping

Every Alfred-created Plane project and issue gets stamped:

```
external_id:      "alfred:<slug>"
external_source:  "alfred"
```

Reverse-sync's guard #1 parses `alfred:<slug>` on any inbound payload
and matches the slug against `project_map` / `issue_map`. Coupled with a
hash match against the last outbound signature for that Plane id, this
is the primary loop defence. Without it the pair would oscillate every
10–15 s.

Humans are free to edit `external_id` in the Plane UI, but they
shouldn't — guard #1 stops firing for that record and you rely on
guards #2 and #3 alone. Alfred does not re-stamp `external_id` on
updates, only on create.

## The `matter` field-name history

Three frontmatter conventions coexist on the fleet today. Forward-sync
resolves them in order (`_resolve_task_matter`):

1. Scalar `matter` — legacy / generator-emitted / manually set / default
   for everything written by skills via ctrl-api today.
2. Scalar `related_matter` — older singular name; found on a handful of
   early tasks on David.
3. Array `related_matters` — what the hourly enrichment pipeline (#395)
   writes. Head of list is the primary match.

Reverse-sync on `issue.updated` writes both `related_matters=[<slug>]`
AND scalar `matter=<slug>` so either convention stays canonical.
Moving an issue into the Inbox project clears both.

## What's NOT synced

Deliberate omissions. Do not add these without reviewing the surveyor +
learn pipelines first.

| Field               | Why not                                                                                                  |
|---------------------|----------------------------------------------------------------------------------------------------------|
| `related_persons`   | Surveyor-owned. Populated by entity resolution, not user-editable in Plane.                              |
| `related_orgs`      | Same as above.                                                                                           |
| `related_projects`  | Vault "project" concept is not Plane's project; mapping would be wrong.                                 |
| `source_event`      | Surveyor-owned. Provenance back to the originating stream event; Plane can't represent it sensibly.      |
| `scope`             | Access-control field; read-only on the vault side.                                                       |
| `created_by` / `updated_by` | Alfred is always "alfred" for issues he writes; reverse would have to map Plane user → vault user and we don't keep that table. |

Human-added Plane labels beyond `alfred-managed` / `alfred-needs-approval` /
`blocked` are also not synced back — they stay in Plane only.

Issue `assignees` are in `LOOP_GUARD_FIELDS` (so assignee changes aren't
a loop amplifier) but are NOT mirrored to vault frontmatter today. If a
future release wants to reflect `assignees` into the vault, add a new
frontmatter field rather than reusing `related_persons`.
