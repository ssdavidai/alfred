# Claude Custom Skills — vendored copies

These are exact copies of the SKILL.md files from
`packages/mcp-server/skills/`. They're served from the SaaS app's
`/mcp-skills/<app>.md` so the Settings page can offer download buttons.

When updating a skill in `packages/mcp-server/skills/`, also re-copy
the file here. CI doesn't enforce sync today; that's a small drift
risk in exchange for a much simpler dependency graph (no monorepo
build-step gymnastics).

Naming: keep the canonical `alfred-<app>.md` shape so existing
download links keep working.
