import { motion } from "framer-motion";
import { ReactNode } from "react";
import { titleRise, fadeUp, stagger, ruleDraw } from "../../lib/motion";

/**
 * The opening beat of every page. One moment of stillness before the content lands.
 * eyebrow: small mono label (e.g. "Today")
 * title:   the chapter title in display italic or roman
 * meta:    optional right-aligned mono datum (e.g. dateline)
 */
export function PageOverture({
  eyebrow,
  title,
  italic = false,
  meta,
  children,
}: {
  eyebrow?: string;
  title: ReactNode;
  italic?: boolean;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <motion.div
      variants={stagger(0.15, 0.12)}
      initial="hidden"
      animate="show"
    >
      {(eyebrow || meta) && (
        <motion.div
          variants={fadeUp}
          className="flex items-baseline justify-between mb-6"
        >
          {eyebrow ? (
            <span
              className="font-mono text-[10px] uppercase tracking-[0.32em]"
              style={{ color: "var(--marginalia)" }}
            >
              {eyebrow}
            </span>
          ) : <span />}
          {meta && (
            <span
              className="font-mono text-[11px] uppercase tracking-[0.22em]"
              style={{ color: "var(--marginalia)" }}
            >
              {meta}
            </span>
          )}
        </motion.div>
      )}

      <motion.h1
        variants={titleRise}
        className="font-display tracking-[-0.02em] leading-[0.98]"
        style={{
          fontSize: "clamp(44px, 6vw, 88px)",
          fontStyle: italic ? "italic" : "normal",
          fontWeight: italic ? 400 : 700,
        }}
      >
        {title}
      </motion.h1>

      <motion.div
        variants={ruleDraw}
        style={{ originX: 0 }}
        className="gilt mt-8 mb-12"
      />

      {children && (
        <motion.div variants={fadeUp}>{children}</motion.div>
      )}
    </motion.div>
  );
}
