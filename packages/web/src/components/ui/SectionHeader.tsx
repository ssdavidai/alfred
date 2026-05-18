import { useRef } from "react";
import { motion, useInView } from "framer-motion";

interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
}

export default function SectionHeader({
  title,
  subtitle,
  icon,
}: SectionHeaderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-40px" });

  return (
    <div ref={ref} className="mb-4">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={isInView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="flex items-center gap-2"
      >
        {icon}
        <h2 className="font-serif text-lg font-light text-cream">{title}</h2>
      </motion.div>
      {subtitle && (
        <motion.p
          initial={{ opacity: 0, y: 8 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.5, ease: "easeOut", delay: 0.1 }}
          className="mt-1 font-sans text-sm font-light text-muted-foreground"
        >
          {subtitle}
        </motion.p>
      )}
      <motion.div
        initial={{ scaleX: 0 }}
        animate={isInView ? { scaleX: 1 } : {}}
        transition={{ duration: 0.6, ease: "easeOut", delay: 0.2 }}
        className="mt-2 h-px origin-left bg-gradient-to-r from-[#C9A84C]/60 to-transparent"
      />
    </div>
  );
}
