import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type GithubEvidenceClient,
  type PaperclipEvidenceClient,
  generateEvidencePacket,
} from "../src/api/evidencePacket.js";

const issues: Record<string, any> = {
  "ALFA-23": {
    id: "issue-23",
    identifier: "ALFA-23",
    title: "Smoke Test — Paperclip to GitHub PR evidence loop",
    status: "done",
    assigneeAgentId: "builder-agent",
    description: "Done work for https://github.com/ssdavidai/alfred-docs/pull/1 with linked review ALFA-24.",
    relatedWork: {
      outbound: [{ issue: { id: "issue-24", identifier: "ALFA-24", title: "Review — ALFA-23 GitHub PR evidence loop", status: "done" } }],
    },
  },
  "issue-23": undefined,
  "ALFA-24": {
    id: "issue-24",
    identifier: "ALFA-24",
    title: "Review — ALFA-23 GitHub PR evidence loop",
    status: "done",
    assigneeAgentId: "reviewer-agent",
    description: "Review of ALFA-23.",
  },
  "issue-24": undefined,
};
issues["issue-23"] = issues["ALFA-23"];
issues["issue-24"] = issues["ALFA-24"];

const comments: Record<string, any[]> = {
  "issue-23": [
    { body: "Checks/tests: npm test passed locally. Evidence: changed docs only." },
    { body: "PR: https://github.com/ssdavidai/alfred-docs/pull/1" },
  ],
  "issue-24": [
    { body: "Reviewer decision: approve. The PR is suitable for the smoke-test evidence loop." },
  ],
};

const paperclip: PaperclipEvidenceClient = {
  async getIssue(issue: string) {
    const found = issues[issue];
    if (!found) throw new Error(`missing fixture issue ${issue}`);
    return found;
  },
  async listComments(issueId: string) {
    return comments[issueId] || [];
  },
};

const github: GithubEvidenceClient = {
  async getPull(prUrl: string) {
    return {
      url: prUrl,
      state: "open",
      merged: false,
      headRef: "alfred-smoke-test",
      baseRef: "main",
      commits: [{ sha: "1234567890abcdef", url: "https://github.com/ssdavidai/alfred-docs/commit/1234567", message: "Add smoke test evidence" }],
      files: [{ filename: "docs/smoke-test.md", status: "added", additions: 12, deletions: 0 }],
    };
  },
};

describe("Paperclip/GitHub evidence packet", () => {
  it("summarises ALFA-23 fixture with open PR and approving ALFA-24 review", async () => {
    const packet = await generateEvidencePacket(
      {
        issue: "ALFA-23",
        prUrl: "https://github.com/ssdavidai/alfred-docs/pull/1",
        paperclipOrigin: "https://paperclip.example.test",
      },
      { paperclip, github },
    );

    assert.equal(packet.issue.identifier, "ALFA-23");
    assert.equal(packet.github_pr?.state, "open");
    assert.equal(packet.github_pr?.merged, false);
    assert.equal(packet.reviewer_decision, "approve");
    assert.equal(packet.linked_review_issues[0].identifier, "ALFA-24");
    assert.equal(packet.linked_review_issues[0].decision, "approve");
    assert.equal(packet.safe_to_mark_done, false);
    assert.match(packet.warnings.join("\n"), /open\/unmerged/);
    assert.match(packet.text, /ALFA-23/);
    assert.match(packet.text, /ALFA-24/);
    assert.match(packet.text, /docs\/smoke-test\.md/);
  });

  it("distinguishes missing PR and absent review evidence", async () => {
    const noPrPaperclip: PaperclipEvidenceClient = {
      async getIssue() {
        return { id: "issue-x", identifier: "ALFA-X", status: "todo", title: "No PR", description: "No links here." };
      },
      async listComments() { return []; },
    };
    const packet = await generateEvidencePacket({ issue: "ALFA-X" }, { paperclip: noPrPaperclip, github });
    assert.equal(packet.github_pr, null);
    assert.equal(packet.reviewer_decision, "unknown");
    assert.equal(packet.safe_to_mark_done, false);
    assert.match(packet.warnings.join("\n"), /missing PR/);
    assert.match(packet.warnings.join("\n"), /no linked review/);
  });
});
