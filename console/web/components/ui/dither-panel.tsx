import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function DitherPanel({
  art,
  children,
  className,
}: {
  art: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative min-h-64 overflow-hidden border border-border",
        className,
      )}
    >
      <div className="absolute inset-0">{art}</div>
      <div className="relative z-10 flex h-full flex-col justify-center px-6 sm:px-10">
        {children}
      </div>
    </div>
  );
}
