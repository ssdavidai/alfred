---
name: alfred-black-design
description: Use this skill to generate well-branded interfaces and assets for Alfred Black, the agentic butler — either for production or throwaway prototypes/mocks/decks. Contains essential design guidelines, colours, type, fonts, the engraved icon set, brand marks, and UI-kit components for prototyping.
user-invocable: true
---

# Alfred Black — Design Skill

Alfred Black is an **agentic butler**: a private, self-hosted AI that handles the
details and surfaces only what needs your judgment. The brand is **letterpress meets
terminal** — ivory paper, wool black, one brass accent, Didone display, Garamond body,
mono machine-voice, sharp corners, hairline rules.

Read **`readme.md`** in this skill for the full system (content fundamentals, visual
foundations, iconography, manifest), then explore the other files.

## Where things are
- `styles.css` — link this one file; it `@import`s every token + font + surface utility.
- `tokens/` — colour, type, spacing, surfaces (`.paper`, `.wool`, `.rule`, `.gilt`, `btn-*`).
- `components/` — React primitives (Button, Pill, Rule, Icon, Seal, CommandField, TextField, Panel, LedgerRow).
- `ui_kits/marketing` & `ui_kits/app` — full-screen recreations to copy from.
- `assets/` — brand marks, the 17 engraved icons, textures.
- `guidelines/cards/` — foundation specimens.

## How to work
- **Visual artifacts (slides, mocks, throwaway prototypes):** copy the assets you need
  out of `assets/`, link `styles.css`, and build self-contained static HTML. Use the
  utility classes and inline the engraved icons from `assets/icons/`. The `ui_kits/`
  files are the best starting points — clone and adapt them.
- **Production code:** copy assets and read the rules here to design fluently in-brand;
  the token values match the shipping product (`ssdavidai/alfred`).

## Non-negotiables
- One brass accent per screen. No second accent, ever. No emoji. Corners stay sharp
  (`--radius: 0`). Serif for what Alfred *says*; mono for machine truth (labels, ledgers).
  Calm, composed copy — never hype. Sign Alfred's prose with *"— Alfred."*

If invoked without guidance, ask what the user wants to build, ask a few focused
questions, then act as an expert Alfred Black designer who outputs HTML artifacts *or*
production code, depending on the need.
