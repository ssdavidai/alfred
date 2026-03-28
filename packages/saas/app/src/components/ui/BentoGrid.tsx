import { cn } from "../../client/utils";

interface BentoGridProps {
  children: React.ReactNode;
  className?: string;
}

export function BentoGrid({ children, className }: BentoGridProps) {
  return (
    <div
      className={cn(
        "grid auto-rows-[minmax(180px,auto)] gap-4",
        "grid-cols-1 md:grid-cols-2 lg:grid-cols-3",
        className,
      )}
    >
      {children}
    </div>
  );
}

interface BentoItemProps {
  children: React.ReactNode;
  className?: string;
  colSpan?: 1 | 2 | 3;
  rowSpan?: 1 | 2;
}

const COL_SPAN_CLASSES: Record<number, string> = {
  1: "col-span-1",
  2: "md:col-span-2",
  3: "lg:col-span-3",
};

const ROW_SPAN_CLASSES: Record<number, string> = {
  1: "row-span-1",
  2: "row-span-2",
};

export function BentoItem({
  children,
  className,
  colSpan = 1,
  rowSpan = 1,
}: BentoItemProps) {
  return (
    <div
      className={cn(
        COL_SPAN_CLASSES[colSpan],
        ROW_SPAN_CLASSES[rowSpan],
        className,
      )}
    >
      {children}
    </div>
  );
}
