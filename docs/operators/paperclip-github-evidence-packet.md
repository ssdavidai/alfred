# Paperclip/GitHub evidence packet

Use this when an agent says a Paperclip issue is complete and the maintainer needs a compact proof trail before closing or promoting the work.

## API

`POST /api/v1/paperclip/evidence-packet`

Body:

```json
{
  "issue": "ALFA-23",
  "prUrl": "https://github.com/ssdavidai/alfred-docs/pull/1",
  "companyId": "optional-company-uuid",
  "paperclipOrigin": "https://paperclip.example.com"
}
```

`issue` may be a Paperclip UUID or identifier. `prUrl` is optional; when omitted the generator looks for the first GitHub PR URL in the issue description and recent comments.

The route reads Paperclip and GitHub only. It does not merge, deploy, close, comment, or mutate either system.

## CLI

From `packages/ctrl`:

```bash
npm run evidence:paperclip-github -- --issue ALFA-23 --pr https://github.com/ssdavidai/alfred-docs/pull/1
```

Add `--json` for the full structured packet.

Required live configuration:

- `PAPERCLIP_API_KEY` for Paperclip reads.
- `PAPERCLIP_BASE_URL` if not running inside compose; defaults to `http://paperclip:3100`.
- `GITHUB_TOKEN` is optional and only used to raise GitHub API limits for public PRs.

## Output posture

The packet includes:

- Paperclip issue status and assignee.
- Linked review issues discovered from Paperclip relationships.
- PR state, branch, commits, changed files, and merge status.
- Checks/tests/review evidence found in Paperclip comments.
- Reviewer decision: `approve`, `request_changes`, `block`, or `unknown`.
- Safety recommendation and warnings for missing PR, open/unmerged PR, merged PR, no review, or weak evidence.

The safety gate is intentionally conservative: it returns `safe_to_mark_done: true` only when the PR is merged, an approving review decision is present, and comment evidence exists. Open/unmerged PRs are reported clearly even when the implementation issue itself is already done.
