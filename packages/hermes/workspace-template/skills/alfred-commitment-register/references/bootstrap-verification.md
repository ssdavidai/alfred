# Bootstrap verification

Use this after the initial records, projection and any schedule have been
created. Each section is a proof obligation: a successful write response is not
one of them.

## 1 · Record proof

- Search by the commitment-ID prefix and confirm the expected count.
- Read every `commitment/` record back in full.
- Check uniqueness, required fields, tags, `matter_ref`, detailed-state /
  coarse-status consistency, and evidence handles.
- Read every deduplicated legacy record and confirm `status: cancelled`,
  `commitment_state: superseded`, and a `superseded_by` link.
- **Do not treat a successful PATCH response as read-back proof.**

Searching by ID prefix has a specific trap. YAML serializers may or may not
quote a scalar, so an exact grep for `commitment_id: ACME-COM-` can silently
undercount records stored as `commitment_id: "ACME-COM-..."`. Search the bare
ID stem (`ACME-COM-2026-`) and validate the parsed frontmatter.

A prefix-search hit count is also not a commitment count: policy notes,
matters and projections quote the ID range and link back to the register once
it exists. Count only `type: commitment` records with a structurally valid ID
and the expected `commitment_scope`; report other hits separately rather than
treating them as duplicates.

## 2 · Projection proof

- Read the rendered projection back through the destination — not the local
  Markdown you generated.
- Verify the intended H1 occurs exactly once, every required section exists,
  the first and highest commitment IDs are present, the update marker occurs
  exactly once, and the canonical-source footer exists.
- Verify destination identity separately from content. For a vault note, the
  path. For Slack, see `slack-projection.md` — `files.info` can return no
  channel for a correctly attached Canvas.
- Record the verified projection identity in the policy note.

## 3 · Schedule proof

A control-plane acknowledgement from `create` or `run` proves only that the
request was accepted.

Require all of the following before calling a schedule test successful:

- the recurring job exists with the intended schedule, skills, toolsets and
  destination;
- a completed run is recorded — `last_run_at` present, terminal status
  successful, no delivery error;
- records were read during that run;
- the projection was updated and read back;
- the expected digest reached the configured destination.

If the workflow logic and projection are exercised manually but the scheduler
records no completed run, report **workflow path verified; scheduler
control-plane run unverified**. Leave the job armed if its configuration is
correct and verify the first natural run later, rather than claiming success.

See also the scheduler self-verification boundary in `SKILL.md`: a run cannot
attest to its own terminal status.

## 4 · Boundary proof

- Re-read the policy's forbidden destinations.
- Confirm no shared or client-facing surface, email recipient, invoice route or
  deliverable was mutated.
- Distinguish evidence reads from external actions in the final report.
