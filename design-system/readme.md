# Alfred Black — Design System

> *"Not an app you use. A person you employ."*

Alfred Black is an **agentic butler** — a single-VM, self-hosted AI that reads the
correspondence, drafts the replies, holds the calendar, and keeps the ledger, then
surfaces only what needs your judgment. The product is a *private command room*, not
a SaaS dashboard. This design system encodes its visual and verbal identity so any
new interface, deck, or asset reads as unmistakably Alfred.

The aesthetic is **letterpress meets terminal**: ivory paper, wool black, a single
brass accent, Didone display type set large and italic, Garamond running text, and a
mono machine-voice for labels and ledgers. Sharp corners. Hairline rules. One gilt
line per page. Serif for human presence; mono for machine truth.

---

## Content fundamentals — how Alfred speaks

Alfred is a butler: **calm, composed, concise, precise.** He never hypes, jokes, or
over-explains. He addresses the principal directly ("you", occasionally "Sir") and
signs his work. The register is formal but warm — Jeeves with a terminal.

**Voice in three registers**
- **Serif (human presence)** — the things Alfred says to you. Full sentences, an
  em-dash, a closing signature: *"The matter is under control. — Alfred."*
- **Mono (machine truth)** — labels, status, audit. Uppercase, wide-tracked, terse:
  `APPROVAL REQUIRED BEFORE EXECUTION`, `DISCRETION MODE ACTIVE`.
- **Italic display** — emphasis and manifesto: *"A person you employ."*

**Casing & punctuation.** Sentence case for prose; UPPERCASE only for mono labels.
Brass `·` interpunct in the wordmark (Alfred·Black). Roman numerals for dates of
record (*Est. MMXXVI*). Oldstyle numerals in body text. No exclamation marks.

**Do say** — Everything important is in hand. · I have prepared this for review. ·
Approval is required before execution. · Discretion mode is active. · No urgent action
is required. · The rest is settled, quietly, by the time you ask.

**Never say** — Boost your productivity. · Next-gen AI workflows. · Oops! · Your AI
super-assistant. · Hey there! · 🎉 / any emoji.

**Taglines** — *Service is the standard. · Your life, attended to. · Classical service.
Terminal precision. · Private by design. Precise by nature.*

**Terminal prompts** — `alfred.black > brief me` · `alfred.black > prepare my week` ·
`alfred.black > review open matters` · `alfred.black > audit last 24h`.

---

## Visual foundations

**Palette.** Wool black `#0B0B0B`, ivory paper `#F4EFE6`, ink `#1A1A1A`, and **one**
antique-brass accent `#A8843A`. *No second accent — ever.* Brass is punctuation: it
marks the single most important thing on a screen (a CTA, an active state, the gilt
rule) then falls silent. State colours (oxblood / billiard-green / amber) are
desaturated and rare; destructive is never fire-red except in safety-critical errors.
Paper is the default surface; **wool is always dark** and never theme-swaps. A dark
mode inverts ink and paper while brass holds.

**Type.** Three families. *Playfair Display* (Didone) for display — set large, tracked
tight (−0.02em), frequently **italic** for emphasis and the wordmark's `Black.`
*EB Garamond* for running text, with oldstyle numerals and generous 1.6 leading.
*JetBrains Mono* for everything machine — labels, nav, marginalia, ledgers — always
uppercase with 0.18–0.32em tracking. Never a bubbly or playful face.

**Corners & borders.** `--radius: 0`. Everything is square; only tiny chips earn 2px.
Structure is drawn with **hairline rules** (`--ab-rule`, ~0.55 alpha ink), never heavy
borders or large filled cards. The one flourish is the **gilt** line — a 1px brass rule
with a soft glow, used *once per page* where the eye should rest.

**Surfaces & texture.** `.paper` and `.wool` carry a fine SVG fractal-noise grain (4px
speckle + 240px turbulence) so backgrounds feel like stock, not screen. No gradients
as decoration; the only gradient is the faint radial brass glow behind a hero. No
glassmorphism, no blur.

**Elevation.** Almost none. Print does not float. Panels sit flat inside hairline
frames; the only shadow is a 1px letterpress impression (`.press`) on display type
over wool, and a heavy scrim shadow on modals. No drop-shadow card stacks.

**Imagery & motifs.** The signature is **Alfred's silhouette** — a monocled gentleman
in bow tie — used as a mark, not a mascot. Empty states use a **single engraved icon**
(pocket watch, key, top hat) in brass with reassuring copy — *"No urgent action is
required."* The **Seal** (a pressed italic "A" in a double ring) signs surfaces
at ~7% opacity in the lower-right gutter. Photography, where used, is warm,
low-key, and grainy — candlelit, never bright stock.

**Motion.** Restrained and cinematic. Entrances are slow blur-and-rise
(`cubic-bezier(0.16, 1, 0.3, 1)`, 0.7–0.95s) and rules "draw" from `originX:0`.
Hover is a 160ms colour/opacity shift toward brass — never a bounce or a scale-pop.
The terminal caret blinks (1s steps). No infinite decorative loops. Respect
`prefers-reduced-motion`.

**Hover / press states.** Links and ghost actions shift to brass on hover; the brass
CTA *fills* with brass and flips its text to paper. Ledger rows wash to 6% brass and
their hairline brasses. Focus-visible is a 1px brass outline at 3px offset. There is
no distinct "pressed/shrink" state — the brand prefers stillness.

---

## Iconography

Alfred ships its **own engraved icon set** — 17 monoline marks at a 32px viewBox,
1.1px stroke, round caps, drawn in `currentColor` so they inherit text colour. They
read as small *engravings*, not UI furniture: `top_hat`, `bow_tie`, `pocket_watch`,
`monocle`, `skeleton_key`, `calling_card`, `envelope`, `calendar`, `matter`,
`approval`, `shield`, `lock`, `globe`, `voice`, `terminal`, `user`, `settings`.

- Use them small (12–20px) and tint via `style={{ color }}` — brass for the one
  accent, ink/marginalia otherwise. Never recolour them with fills or use them as
  large hero illustration.
- **Emoji are never used.** Unicode `●`, `→`, `↓`, `·`, `✕` and roman numerals are the
  only non-icon glyphs in the vocabulary.
- **No ASCII / dot-matrix art.** The engraved icon set carries the whole iconographic
  load — including empty states, where a single icon is set large in brass.

If you need an icon outside the set, draw it to match: single monoline stroke ~1.1px,
round caps/joins, 32px box, no fills.

---

## Using it

Link the one stylesheet and opt a surface into the base:

```html
<link rel="stylesheet" href="styles.css">
<body class="ab-base paper">…</body>   <!-- or class="ab-base wool" for the dark room -->
```

Then reach for utility classes (`btn-brass`, `pill-brass`, `rule`, `gilt`, `font-display`),
keep one brass note per screen, set the human voice in serif and the machine voice in
mono, and leave the corners sharp.

---

## Provenance

The token values, surfaces, and button family here are **lifted verbatim from the
shipping product theme** at `packages/web/src/client/Main.css`. That file is the source
of truth, above any mockup. When recreating a product surface, read the component code
first; the mockups are a high-level guide only.

See `IMPORTED.md` for what this snapshot contains, what was deliberately left out, and
the one place the older `_brandpack/` layer contradicts this document.
