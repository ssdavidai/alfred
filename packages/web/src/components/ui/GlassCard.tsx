import { motion } from "framer-motion";
import { cn } from "../../client/utils";

interface GlassCardProps {
  title?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export default function GlassCard({
  title,
  icon,
  children,
  className,
}: GlassCardProps) {
  return (
    <motion.div
      whileHover={{
        scale: 1.02,
        boxShadow: "0 0 20px rgba(201,168,76,0.15), 0 0 40px rgba(201,168,76,0.05)",
      }}
      transition={{ type: "spring", stiffness: 300, damping: 20 }}
      className={cn(
        "rounded-sm border border-white/10 bg-black/40 backdrop-blur-md",
        "transition-colors duration-300 hover:border-amber-500/30",
        className,
      )}
    >
      {(title || icon) && (
        <div className="flex items-center gap-2 px-4 pt-4 pb-1">
          {icon}
          {title && (
            <span className="font-serif text-base font-light text-cream">
              {title}
            </span>
          )}
        </div>
      )}
      <div className="p-4">{children}</div>
    </motion.div>
  );
}
