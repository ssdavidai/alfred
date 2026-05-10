import type { Variants, Transition } from "framer-motion";
import { useReducedMotion } from "framer-motion";

/**
 * Alfred motion language — slow, considered, theatrical.
 * Single source of truth so every page opens the same way.
 */

const slowOut: Transition["ease"] = [0.16, 1, 0.3, 1];

export const titleRise: Variants = {
  hidden: { y: 28, opacity: 0, filter: "blur(8px)" },
  show: {
    y: 0,
    opacity: 1,
    filter: "blur(0px)",
    transition: { duration: 0.9, ease: slowOut },
  },
};

export const fadeUp: Variants = {
  hidden: { y: 14, opacity: 0 },
  show: {
    y: 0,
    opacity: 1,
    transition: { duration: 0.55, ease: slowOut },
  },
};

export const stagger = (delay = 0, stagger = 0.08): Variants => ({
  hidden: {},
  show: {
    transition: { delayChildren: delay, staggerChildren: stagger },
  },
});

export const curtain: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.45, ease: slowOut } },
  exit: { opacity: 0, transition: { duration: 0.25, ease: "easeIn" } },
};

export const ruleDraw: Variants = {
  hidden: { scaleX: 0 },
  show: {
    scaleX: 1,
    transition: { duration: 0.8, ease: slowOut },
  },
};

export const HOLD_MS = 120;

export function useMotionSafe<T>(value: T, fallback: T): T {
  const reduced = useReducedMotion();
  return reduced ? fallback : value;
}
