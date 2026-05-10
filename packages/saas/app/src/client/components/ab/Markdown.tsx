// On-brand markdown renderer. Adds [[wikilink]] support on top of the basics.
//
// Wikilink resolution is deliberately decoupled here. Two optional props:
//   onLink(title)        — fires when the user clicks a wikilink button.
//   resolveTitle(title)  — placeholder hook for the live title-index lookup
//                          (XC #873). When supplied, the resolved value is
//                          surfaced via the button's `data-resolved` attr so
//                          callers can later style "exists" vs "broken" links.
//                          Until #873 lands, callers should not pass this prop;
//                          the API is here so it can be wired in without a
//                          breaking change.

import type { ReactNode } from "react";

export type MarkdownProps = {
  source: string;
  onLink?: (title: string) => void;
  resolveTitle?: (title: string) => string | undefined;
};

function inline(
  src: string,
  onLink?: (title: string) => void,
  resolveTitle?: (title: string) => string | undefined,
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
      const title = tok.slice(2, -2).trim();
      const resolved = resolveTitle?.(title);
      out.push(
        <button
          key={i++}
          onClick={() => onLink?.(title)}
          data-resolved={resolved ?? undefined}
          className="font-display italic underline-offset-4 hover:underline"
          style={{ color: "var(--brass)" }}
        >
          {title}
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

export function Markdown({ source, onLink, resolveTitle }: MarkdownProps) {
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
            {inline(text, onLink, resolveTitle)}
          </h1>,
        );
      } else if (lvl === 2) {
        blocks.push(
          <h2 key={key++} className="font-mono text-[10px] uppercase tracking-[0.22em] mt-8 mb-3"
              style={{ color: "var(--brass)" }}>
            {inline(text, onLink, resolveTitle)}
          </h2>,
        );
      } else {
        blocks.push(
          <h3 key={key++} className="font-display italic text-xl mt-6 mb-2">
            {inline(text, onLink, resolveTitle)}
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
          {inline(buf.join(" "), onLink, resolveTitle)}
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
                  <td key={ci} className="py-3 pr-4 text-[15px] align-top">{inline(c, onLink, resolveTitle)}</td>
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
              <span>{inline(it, onLink, resolveTitle)}</span>
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
        {inline(buf.join(" "), onLink, resolveTitle)}
      </p>,
    );
  }

  return <div>{blocks}</div>;
}
