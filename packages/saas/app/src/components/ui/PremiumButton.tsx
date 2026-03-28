import { motion } from "framer-motion";
import { cn } from "../../client/utils";

type Variant = "primary" | "secondary" | "ghost";

interface PremiumButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  children: React.ReactNode;
}

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-gradient-to-b from-[#D4AF37] to-[#B8860B] text-black font-medium shadow-md hover:shadow-[0_0_16px_rgba(201,168,76,0.35)]",
  secondary:
    "border border-[#C9A84C]/40 bg-transparent text-[#C9A84C] hover:border-[#C9A84C]/70 hover:shadow-[0_0_12px_rgba(201,168,76,0.15)]",
  ghost:
    "bg-transparent text-[#C9A84C]/80 hover:text-[#C9A84C] hover:bg-[#C9A84C]/5",
};

export default function PremiumButton({
  variant = "primary",
  className,
  children,
  ...props
}: PremiumButtonProps) {
  return (
    <motion.button
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.98 }}
      transition={{ type: "spring", stiffness: 400, damping: 17 }}
      className={cn(
        "inline-flex items-center justify-center rounded-sm px-4 py-2 font-sans text-sm transition-colors duration-200",
        variantClasses[variant],
        className,
      )}
      {...(props as any)}
    >
      {children}
    </motion.button>
  );
}
