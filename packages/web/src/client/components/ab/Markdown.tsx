// On-brand markdown renderer. Adds [[wikilink]] support on top of the basics.
//
// Wikilink resolution is deliberately decoupled here. Two optional props:
//   onLink(title)        — fires when the user clicks a wikilink button.
//   resolveTitle(title)  — title → slug lookup. When supplied, the resolved
//                          value is surfaced via the button's `data-resolved`
//                          attr so callers can later style "exists" vs
//                          "broken" links.
//
// Default resolver: when neither prop is supplied, Markdown auto-wires a
// resolver against the live `getVaultTitleIndex` Wasp query (XC #873) so
// any rendered tenant content gets working wikilinks for free. Static
// contexts (marketing pages, tests, anywhere outside the SaaS app) can
// pass `resolveTitle={undefined}` explicitly OR set `useLiveResolver={false}`
// to opt out.

import type { ReactNode } from "react";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, getVaultTitleIndex } from "wasp/client/operations";

export type MarkdownProps = {
  source: string;
  onLink?: (title: string) => void;
  resolveTitle?: (title: string) => string | undefined;
  /**
   * Reverse lookup used to render a wikilink as a human title when the
   * source text is a slug (e.g., `[[matter/family-life-hannas-first-year]]`
   * → "Robin's First Year"). Returns undefined when no nicer display is
   * known; the renderer falls back to the raw `[[...]]` content.
   */
  resolveDisplay?: (raw: string) => string | undefined;
  /**
   * Opt out of the default getVaultTitleIndex-backed resolver. Set this to
   * false in any context that doesn't run inside an authenticated Wasp
   * client (e.g., a static marketing preview).
   */
  useLiveResolver?: boolean;
};

function inline(
  src: string,
  onLink?: (title: string) => void,
  resolveTitle?: (title: string) => string | undefined,
  resolveDisplay?: (raw: string) => string | undefined,
): ReactNode[] {
  const out: ReactNode[] = [];
  // wikilinks first, then bold/italic/code
  const re = /(\[\[[^\]]+\]\]|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("[[")) {
      const raw = tok.slice(2, -2).trim();
      const resolved = resolveTitle?.(raw);
      // Render the human title when the source is a slug-shaped wikilink
      // (e.g. `[[matter/family-life-hannas-first-year]]`). Falls back to
      // the raw token when no nicer display is known.
      const displayText = resolveDisplay?.(raw) ?? raw;
      out.push(
        <button
          key={i++}
          onClick={() => onLink?.(raw)}
          data-resolved={resolved ?? undefined}
          className="font-display italic underline-offset-4 hover:underline"
          style={{ color: "var(--brass)" }}
        >
          {displayText}
        </button>,
      );
    } else if (tok.startsWith("**")) {
      out.push(
        <strong key={i++} className="font-display" style={{ fontWeight: 700 }}>
          {tok.slice(2, -2)}
        </strong>,
      );
    } else if (tok.startsWith("`")) {
      out.push(
        <code key={i++} className="font-mono text-[0.85em]" style={{ color: "var(--brass)" }}>
          {tok.slice(1, -1)}
        </code>,
      );
    } else {
      out.push(
        <em key={i++} style={{ color: "var(--marginalia)" }}>
          {tok.slice(1, -1)}
        </em>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

// ---------------------------------------------------------------------------
// Default live resolver
//
// Wraps useQuery(getVaultTitleIndex) into the same (title) => slug | undefined
// shape Markdown's resolveTitle prop expects. Lookup is case-insensitive on
// the title; the slug is what we'd navigate to (`/dashboard/vault/<slug>`)
// when the wikilink is clicked.
// ---------------------------------------------------------------------------

function useLiveTitleIndex(): {
  resolve: (title: string) => string | undefined;
  resolveDisplay: (raw: string) => string | undefined;
  navigateToSlug: (slug: string) => void;
} {
  const navigate = useNavigate();
  // Marketing pages still mount this hook because Markdown is also used by
  // FirstBriefPage (auth) and would-be future static contexts. The Wasp
  // query short-circuits to 401 on unauth — we swallow it via getVaultTitleIndex's
  // try/catch, which returns { titles: [] } so this hook degrades gracefully.
  const { data } = useQuery(getVaultTitleIndex, undefined, {
    refetchInterval: false,
    retry: false,
    staleTime: 60_000,
  });

  const { titleToSlug, slugToTitle } = useMemo(() => {
    const titles = (data?.titles ?? []) as Array<{
      title: string;
      slug: string;
    }>;
    const titleToSlug = new Map<string, string>();
    const slugToTitle = new Map<string, string>();
    for (const t of titles) {
      if (!t?.title || !t?.slug) continue;
      titleToSlug.set(t.title.toLowerCase().trim(), t.slug);
      slugToTitle.set(t.slug.toLowerCase().trim(), t.title);
    }
    return { titleToSlug, slugToTitle };
  }, [data]);

  const resolve = (title: string): string | undefined => {
    if (!title) return undefined;
    const k = title.toLowerCase().trim();
    // Either input form may carry a known slug; in that case it's already
    // navigable, so just echo it back.
    return titleToSlug.get(k) ?? (slugToTitle.has(k) ? k : undefined);
  };

  const resolveDisplay = (raw: string): string | undefined => {
    if (!raw) return undefined;
    return slugToTitle.get(raw.toLowerCase().trim());
  };

  const navigateToSlug = (slug: string) => {
    navigate(`/dashboard/vault/${slug}`);
  };

  return { resolve, resolveDisplay, navigateToSlug };
}

// Static (no-resolver) variant for contexts that don't run inside a
// router + Wasp auth client. Callers explicitly opt in by setting
// `useLiveResolver={false}`.
function MarkdownStatic({
  source,
  onLink,
  resolveTitle,
  resolveDisplay,
}: Omit<MarkdownProps, "useLiveResolver">) {
  return renderBlocks(source, onLink, resolveTitle, resolveDisplay);
}

// Live variant — auto-resolves wikilinks against getVaultTitleIndex.
function MarkdownLive({
  source,
  onLink,
  resolveTitle,
  resolveDisplay,
}: Omit<MarkdownProps, "useLiveResolver">) {
  const live = useLiveTitleIndex();
  // Caller-supplied resolvers win; fall back to the live ones. When
  // neither resolveTitle nor onLink is supplied, we auto-wire onLink so
  // [[wikilink]] clicks navigate to /dashboard/vault/<slug> when known.
  const effectiveResolve = resolveTitle ?? live.resolve;
  const effectiveDisplay = resolveDisplay ?? live.resolveDisplay;
  const effectiveOnLink =
    onLink ??
    ((raw: string) => {
      const slug = live.resolve(raw);
      if (slug) live.navigateToSlug(slug);
    });
  return renderBlocks(source, effectiveOnLink, effectiveResolve, effectiveDisplay);
}

export function Markdown(props: MarkdownProps) {
  // Hooks must run unconditionally — branch on the prop and pick a variant.
  // The two variants have identical render output; only the resolver hook
  // call differs.
  if (props.useLiveResolver === false) {
    return (
      <MarkdownStatic
        source={props.source}
        onLink={props.onLink}
        resolveTitle={props.resolveTitle}
        resolveDisplay={props.resolveDisplay}
      />
    );
  }
  return (
    <MarkdownLive
      source={props.source}
      onLink={props.onLink}
      resolveTitle={props.resolveTitle}
      resolveDisplay={props.resolveDisplay}
    />
  );
}

function renderBlocks(
  source: string,
  effectiveOnLink: ((title: string) => void) | undefined,
  effectiveResolve: ((title: string) => string | undefined) | undefined,
  effectiveDisplay: ((raw: string) => string | undefined) | undefined,
): ReactNode {

  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      const text = h[2];
      if (lvl === 1) {
        blocks.push(
          <h1 key={key++} className="font-display text-4xl tracking-tight leading-[1.05] mb-4">
            {inline(text, effectiveOnLink, effectiveResolve, effectiveDisplay)}
          </h1>,
        );
      } else if (lvl === 2) {
        blocks.push(
          <h2 key={key++} className="font-mono text-[10px] uppercase tracking-[0.22em] mt-8 mb-3"
              style={{ color: "var(--brass)" }}>
            {inline(text, effectiveOnLink, effectiveResolve, effectiveDisplay)}
          </h2>,
        );
      } else {
        blocks.push(
          <h3 key={key++} className="font-display italic text-xl mt-6 mb-2">
            {inline(text, effectiveOnLink, effectiveResolve, effectiveDisplay)}
          </h3>,
        );
      }
      i++; continue;
    }

    if (line.trim() === "---") {
      blocks.push(<hr key={key++} className="rule my-6" />);
      i++; continue;
    }

    if (line.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        buf.push(lines[i].replace(/^>\s?/, "")); i++;
      }
      blocks.push(
        <blockquote key={key++}
          className="border-l pl-5 my-5 font-display italic text-[19px] leading-snug"
          style={{ borderColor: "var(--brass)", color: "var(--ink)" }}>
          {inline(buf.join(" "), effectiveOnLink, effectiveResolve, effectiveDisplay)}
        </blockquote>,
      );
      continue;
    }

    if (line.startsWith("|") && lines[i + 1]?.match(/^\|[\s\-|:]+\|$/)) {
      const head = line.split("|").slice(1, -1).map((s) => s.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        rows.push(lines[i].split("|").slice(1, -1).map((s) => s.trim())); i++;
      }
      blocks.push(
        <table key={key++} className="w-full my-5 border-y border-rule font-body">
          <thead>
            <tr style={{ color: "var(--marginalia)" }}>
              {head.map((h, j) => (
                <th key={j} className="text-left py-2 font-mono text-[10px] uppercase tracking-[0.22em] font-normal border-b border-rule">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className="border-b border-rule">
                {r.map((c, ci) => (
                  <td key={ci} className="py-3 pr-4 text-[15px] align-top">{inline(c, effectiveOnLink, effectiveResolve, effectiveDisplay)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, "")); i++;
      }
      blocks.push(
        <ul key={key++} className="my-4 space-y-2">
          {items.map((it, j) => (
            <li key={j} className="grid grid-cols-[14px_1fr] gap-3 font-body text-[16px] leading-snug">
              <span style={{ color: "var(--brass)" }}>·</span>
              <span>{inline(it, effectiveOnLink, effectiveResolve, effectiveDisplay)}</span>
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    const buf: string[] = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#|>|[-*]\s|\|)/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    blocks.push(
      <p key={key++} className="font-body text-[17px] leading-[1.6] my-3">
        {inline(buf.join(" "), effectiveOnLink, effectiveResolve, effectiveDisplay)}
      </p>,
    );
  }

  return <div>{blocks}</div>;
}
