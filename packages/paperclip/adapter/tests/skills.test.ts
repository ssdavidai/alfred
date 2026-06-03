/**
 * Skills surface tests — verify the adapter surfaces Hermes' loaded skill
 * set (read-only) from the mounted skills directory, parses SKILL.md
 * frontmatter, and degrades honestly when the mount is absent.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  makeListSkills,
  makeSyncSkills,
  parseSkillFrontmatter,
  resolveDesiredSkillNames,
} from "../src/server/skills.js";

const CONFIG_DIR = "/hermes-state/profiles";
const SKILLS_DIR = `${CONFIG_DIR}/main/skills`;

/** Build a fake fs that serves SKILL.md content keyed by slug. */
function fakeFs(skills: Record<string, string | null>) {
  return {
    listDir: (dir: string): string[] => {
      if (dir !== SKILLS_DIR) throw new Error(`ENOENT: ${dir}`);
      return Object.keys(skills);
    },
    readFile: (file: string): string => {
      for (const [slug, content] of Object.entries(skills)) {
        if (file === `${SKILLS_DIR}/${slug}/SKILL.md`) {
          if (content === null) throw new Error(`ENOENT: ${file}`);
          return content;
        }
      }
      throw new Error(`ENOENT: ${file}`);
    },
  };
}

describe("parseSkillFrontmatter", () => {
  it("extracts name, description, and version", () => {
    const fm = parseSkillFrontmatter(
      [
        "---",
        "name: alfred-daily-briefing",
        "description: Assemble and deliver the morning briefing.",
        'version: "2.6"',
        "---",
        "",
        "# Body",
      ].join("\n"),
    );
    assert.equal(fm.name, "alfred-daily-briefing");
    assert.equal(fm.description, "Assemble and deliver the morning briefing.");
    assert.equal(fm.version, "2.6");
  });

  it("returns nulls when there is no frontmatter", () => {
    const fm = parseSkillFrontmatter("# Just a body, no frontmatter\n");
    assert.equal(fm.name, null);
    assert.equal(fm.description, null);
    assert.equal(fm.version, null);
  });

  it("ignores nested keys (metadata: / triggers:) and missing version", () => {
    const fm = parseSkillFrontmatter(
      [
        "---",
        "name: alfred-voice",
        "description: Phone call behaviour.",
        "metadata:",
        "  openclaw:",
        '    emoji: "☎️"',
        "---",
        "body",
      ].join("\n"),
    );
    assert.equal(fm.name, "alfred-voice");
    assert.equal(fm.description, "Phone call behaviour.");
    assert.equal(fm.version, null);
  });
});

describe("listSkills", () => {
  it("returns a real, non-empty snapshot from the mounted skills dir", async () => {
    const listSkills = makeListSkills({
      configDir: CONFIG_DIR,
      ...fakeFs({
        "alfred-daily-briefing": [
          "---",
          "name: alfred-daily-briefing",
          "description: Morning briefing.",
          'version: "2.6"',
          "---",
        ].join("\n"),
        "vault-curator": [
          "---",
          "name: vault-curator",
          "description: Process raw inbound content into vault records.",
          'version: "2.0"',
          "---",
        ].join("\n"),
      }),
    });

    const snap = await listSkills({ config: {} });
    assert.equal(snap.adapterType, "hermes_local");
    assert.equal(snap.supported, true);
    assert.equal(snap.mode, "persistent");
    assert.equal(snap.entries.length, 2);

    // Entries are sorted by slug.
    const first = snap.entries[0]!;
    assert.equal(first.key, "alfred-daily-briefing");
    assert.equal(first.runtimeName, "alfred-daily-briefing");
    assert.equal(first.state, "installed");
    assert.equal(first.readOnly, true);
    assert.equal(first.origin, "hermes-runtime");
    assert.equal(first.sourcePath, `${SKILLS_DIR}/alfred-daily-briefing/SKILL.md`);
    assert.ok(first.detail?.includes("Morning briefing."));
    assert.ok(first.detail?.includes("v2.6"));
    assert.equal(first.locationLabel, "main profile");
  });

  it("falls back to slug when SKILL.md lacks a name", async () => {
    const listSkills = makeListSkills({
      configDir: CONFIG_DIR,
      ...fakeFs({
        "no-name-skill": ["---", "description: A skill with no name.", "---"].join(
          "\n",
        ),
      }),
    });
    const snap = await listSkills({ config: {} });
    assert.equal(snap.entries.length, 1);
    assert.equal(snap.entries[0]!.runtimeName, "no-name-skill");
  });

  it("skips directories without a SKILL.md and warns", async () => {
    const listSkills = makeListSkills({
      configDir: CONFIG_DIR,
      ...fakeFs({
        "real-skill": ["---", "name: real-skill", "---"].join("\n"),
        "stray-dir": null, // no SKILL.md
      }),
    });
    const snap = await listSkills({ config: {} });
    assert.equal(snap.supported, true);
    assert.equal(snap.entries.length, 1);
    assert.equal(snap.entries[0]!.key, "real-skill");
    assert.ok(snap.warnings.some((w) => w.includes("stray-dir")));
  });

  it("degrades to unsupported when the skills dir is not readable", async () => {
    const listSkills = makeListSkills({
      configDir: CONFIG_DIR,
      listDir: () => {
        throw new Error("ENOENT: mount absent");
      },
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    const snap = await listSkills({ config: {} });
    assert.equal(snap.supported, false);
    assert.equal(snap.mode, "unsupported");
    assert.equal(snap.entries.length, 0);
    assert.ok(snap.warnings[0]!.includes("not readable"));
  });
});

describe("syncSkills", () => {
  it("returns the read snapshot plus a read-only sync warning", async () => {
    const syncSkills = makeSyncSkills({
      configDir: CONFIG_DIR,
      ...fakeFs({
        "real-skill": ["---", "name: real-skill", "---"].join("\n"),
      }),
    });
    const snap = await syncSkills({ config: {} }, ["whatever"]);
    assert.equal(snap.supported, true);
    assert.equal(snap.entries.length, 1);
    assert.ok(snap.warnings.some((w) => w.includes("read-only")));
  });
});

describe("resolveDesiredSkillNames", () => {
  it("returns [] so Paperclip's missing-detector never lights up", () => {
    assert.deepEqual(resolveDesiredSkillNames({}, []), []);
  });
});
