/**
 * A pressed monogram — signs the page in the lower-right gutter at low opacity.
 * Pure SVG so it's crisp at any size and inherits color via currentColor.
 */
export function Seal({ size = 96 }: { size?: number }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none select-none fixed bottom-6 right-6 z-0"
      style={{ opacity: 0.07, color: "var(--ink)" }}
    >
      <svg width={size} height={size} viewBox="0 0 100 100" fill="none">
        <circle cx="50" cy="50" r="46" stroke="currentColor" strokeWidth="0.6" />
        <circle cx="50" cy="50" r="40" stroke="currentColor" strokeWidth="0.4" />
        <text
          x="50"
          y="60"
          textAnchor="middle"
          fontFamily="Playfair Display, serif"
          fontSize="42"
          fontStyle="italic"
          fill="currentColor"
        >
          A
        </text>
      </svg>
    </div>
  );
}
