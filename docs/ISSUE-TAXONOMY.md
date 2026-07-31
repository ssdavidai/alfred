# Issue prioritization taxonomy

Every **open issue** carries exactly one label from each single-value
dimension below, plus at least one `area:*`. This is what lets a portfolio
review filter Now/Next/Later and weigh impact against effort without reading
every issue's prose (#309).

Enforced by `.github/workflows/issue-taxonomy.yml` via
`scripts/check_issue_taxonomy.py`:

- **on issue open/reopen** — advisory comment naming the missing dimensions.
- **weekly sweep (Mon 06:00 UTC)** — fails if any open issue is unclassified.

Run it yourself any time:

```bash
python3 scripts/check_issue_taxonomy.py --repo ssdavidai/alfred
python3 scripts/check_issue_taxonomy.py --repo ssdavidai/alfred --strict
```

## The dimensions

| Dimension | Values | Question it answers |
|---|---|---|
| `kind:` | `bug` · `feature` · `platform` · `ops` · `product-ops` · `research` | What investment class is this? |
| `impact:` | `critical` · `high` · `medium` · `low` | How big is the product/business consequence? |
| `effort:` | `xs` · `s` · `m` · `l` · `xl` | Coarse delivery complexity. |
| `priority:` | `p0` · `p1` · `p2` · `p3` | Explicit sequence decision. |
| `horizon:` | `now` · `next` · `later` | Which planning window. |
| `customer:` | `blocking` · `degraded` · `quality` · `internal` | What the principal actually experiences. |
| `theme:` | `trust` · `reliability` · `scale` · `activation` · `productivity` · `governance` | Which strategic thread it advances. |
| `area:` | `api` `channels` `ci` `core` `desk` `files` `finance` `ha` `hermes` `integrations` `learn` `ops` `paperclip` `runtime` `security` `voice` | Ownership. **One or more.** |

## Rubric

**`priority:`** — the only dimension that encodes a decision rather than a
description. Keep it honest; if everything is `p1`, nothing is.

- `p0` — active incident, security exposure, data loss, or fleet-wide outage
  risk. Someone is working on it *now*.
- `p1` — committed in the current planning window.
- `p2` — important, scheduled after the current p0/p1 commitments.
- `p3` — opportunistic, discovery, or backlog.

**`impact:`** — consequence if left unfixed, independent of how hard it is.

- `critical` — the product is untrustworthy or unusable for its core job.
- `high` — a primary surface is materially degraded or wrong.
- `medium` — noticeable friction with a workaround.
- `low` — cosmetic or rare.

**`effort:`** — `xs` under an hour · `s` under a day · `m` a few days ·
`l` a week-plus · `xl` needs decomposition into child issues.

**`customer:`** — resist defaulting to `internal`.

- `blocking` — the principal cannot complete a task.
- `degraded` — it works, but wrongly or unreliably.
- `quality` — correctness/polish the principal would notice over time.
- `internal` — operators and developers only.

## Portfolio views

Ready-made filters (append to `https://github.com/ssdavidai/alfred/issues?q=`):

| View | Query |
|---|---|
| **Now** | `is:open is:issue label:horizon:now sort:created-asc` |
| **Next** | `is:open is:issue label:horizon:next` |
| **Later** | `is:open is:issue label:horizon:later` |
| **Active incidents** | `is:open is:issue label:priority:p0` |
| **Big win, small cost** | `is:open is:issue label:impact:critical,impact:high label:effort:xs,effort:s` |
| **Principal-facing pain** | `is:open is:issue label:customer:blocking,customer:degraded` |
| **Trust thread** | `is:open is:issue label:theme:trust` |
| **Unclassified (should be empty)** | `is:open is:issue -label:priority:p0 -label:priority:p1 -label:priority:p2 -label:priority:p3` |

Save these as repository saved views (Issues → Save view) so they persist per
reader without hard-coding anyone's preferences into the repo.

## Conventions

- **Epics** additionally carry the `epic` label and link their children.
- **`alfred-code`** marks an issue eligible for automated specification and
  execution — orthogonal to the dimensions above.
- Changing a label is auditable in the issue's own timeline; the rubric lives
  here, in the repository, so it is versioned alongside the code.
- Closed issues are not swept — the taxonomy governs the *live* portfolio.
