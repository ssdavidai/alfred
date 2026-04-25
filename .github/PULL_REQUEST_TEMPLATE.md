## Summary

<!-- 1-3 bullets on what changed and why. -->

## Test plan

- [ ] <!-- how this was tested locally -->
- [ ] <!-- what to verify post-deploy -->

## Temporal versioning checklist (delete if not applicable)

If this PR touches Temporal workflows or activities, confirm:

- [ ] No activity has been **renamed** without keeping a backwards-compat shim under the old name (use `name=` arg on `@activity.defn`)
- [ ] No workflow signature has changed in a way that breaks history replay (params added/removed/reordered)
- [ ] If logic order changed inside a workflow, used `workflow.patched(<name>)` or `use_compatible_version()` to gate the new path
- [ ] If new activities are added, registered in `packages/learn/src/worker.py`
- [ ] Pre-deploy plan documented for in-flight workflows: terminate, drain, OR rely on patched-version compat
- [ ] Tested locally with a workflow started under old code + replayed under new code if the change is non-additive

Worked example of what happens when this is skipped: PR #628 renamed `plane_sync.fetch_changed_tasks` and rewrote workflow logic without `workflow.patched()`. In-flight workflows started by old code hit `NonDeterministicError` while replaying their history under the new code, stalled for 12+ minutes on David + Rapali post-deploy, and required manual termination to recover.
