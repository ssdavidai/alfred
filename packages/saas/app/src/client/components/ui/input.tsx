import * as React from "react";

import { cn } from "../../utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full border-0 border-b border-gold-dim bg-transparent px-0 py-2 text-sm font-light text-foreground transition-colors file:border-0 file:bg-transparent file:text-sm file:font-light placeholder:text-muted-foreground focus:border-b-gold focus:outline-none focus:ring-0 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
