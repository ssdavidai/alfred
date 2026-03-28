import { useState, useRef } from "react";
import { motion } from "framer-motion";
import { cn } from "../../client/utils";

interface SpotlightCardProps {
  children: React.ReactNode;
  className?: string;
  title?: string;
  icon?: React.ReactNode;
}

export default function SpotlightCard({
  children,
  className,
  title,
  icon,
}: SpotlightCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [isHovered, setIsHovered] = useState(false);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    setMousePos({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  };

  return (
    <motion.div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      whileHover={{ scale: 1.01 }}
      transition={{ type: "spring" as const, stiffness: 300, damping: 20 }}
      className={cn(
        "relative overflow-hidden rounded-xl border border-white/[0.08] bg-black/40 backdrop-blur-md",
        "transition-colors duration-300 hover:border-amber-500/20",
        className,
      )}
    >
      {/* Spotlight gradient overlay */}
      {isHovered && (
        <div
          className="pointer-events-none absolute inset-0 z-0 transition-opacity duration-300"
          style={{
            background: `radial-gradient(600px circle at ${mousePos.x}px ${mousePos.y}px, rgba(201,168,76,0.15), transparent 40%)`,
          }}
        />
      )}

      <div className="relative z-10">
        {(title || icon) && (
          <div className="flex items-center gap-2 px-4 pt-4 pb-1">
            {icon}
            {title && (
              <span className="font-serif text-base font-light text-[#F0EDE8]">
                {title}
              </span>
            )}
          </div>
        )}
        <div className="p-4">{children}</div>
      </div>
    </motion.div>
  );
}
