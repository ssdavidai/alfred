# Imported — provenance, scope, and one contradiction

**Source:** Claude Design project `e1a3afca-fdb4-4a71-95fd-163c4cd0653c`
("Alfred Black Design System").
**Snapshot date:** 2026-08-15.

This is a **point-in-time snapshot, not a live sync.** Editing files here does not
change the design project, and changes made there do not appear here until someone
re-imports.

**To re-sync:** use the `DesignSync` tool with the project id above —
`list_files`, then `get_file` per path. Read methods only; do not push repo state back
into the design project.

---

## What this snapshot contains

The **buildable core** — everything needed to write in-brand CSS and markup:

| path | what |
|---|---|
| `readme.md` | **the authoritative system document** — voice, palette, type, surfaces, iconography |
| `SKILL.md` | portable Agent-Skill wrapper |
| `styles.css` | single entry point; `@import`s every token file in order |
| `tokens/fonts.css` | Playfair Display · EB Garamond · JetBrains Mono |
| `tokens/colors.css` | material + semantic + `.dark` scope |
| `tokens/typography.css` | display/body/mono scales, tracking, leading |
| `tokens/spacing.css` | `--radius: 0`, 4px scale, hairlines, layout widths |
| `tokens/surfaces.css` | `.paper` `.wool` `.rule` `.gilt` `.press`, the button family |
| `templates/attention-statement/` | the canonical Attention Statement layout |
| `_brandpack/prompts/UI_RULES.md` | the ten UI rules (older layer) |
| `_brandpack/ui-kit/components/COMPONENT_RULES.md` | panels, buttons, inputs, tables (older layer) |

## What is deliberately NOT here

- **`uploads/`** — client PDFs, a competitive-landscape report, and personal travel
  documents. **This repository is public.** These must never be committed.
- **`screenshots/`, `_brandpack/references/`** — large PNG renders with no build value.
- **Root one-off documents** — landing pages, decks, ebooks, thesis inserts. They are
  outputs of the system, not the system.
- **`components/`, `assets/`, `icons/`, `guidelines/cards/`** — the React primitives,
  the 17 engraved SVG icons, brand marks and textures. **Not yet imported.** They are
  wanted; they were left out of this pass to keep it reviewable. Until they land,
  `readme.md`'s iconography section describes assets that are not in this directory.

## Sample data was scrubbed

`templates/attention-statement/AttentionStatement.dc.html` shipped with a real client
company name in its standfirst and is a client-facing document. The name has been
replaced with the fictional **Northwind & Co**. Any future import must repeat this
check before committing — the design project is private, this repository is not.

---

## The one contradiction, and which side wins

`readme.md` and the older `_brandpack/` layer disagree about ASCII art:

- **`readme.md`** (newer, authoritative): *"No ASCII / dot-matrix art. The engraved
  icon set carries the whole iconographic load — including empty states, where a
  single icon is set large in brass."*
- **`_brandpack/prompts/UI_RULES.md`** rule 4: *"Use ASCII/dot-matrix as atmosphere,
  not decoration spam."*
- **`_brandpack/ui-kit/components/COMPONENT_RULES.md`**, Empty States: *"Use ASCII
  object engravings: top hat, watch, key, monocle, bow tie."*

**`readme.md` wins.** `SKILL.md` names it as the full system, and it is the later
document. `_brandpack/` is retained for its assets, type system and copy rules — not
as a source of layout law. Both conflicting files carry an inline note pointing here.

If you are about to add ASCII art to an Alfred surface, you are following the dead rule.
