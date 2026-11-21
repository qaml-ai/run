import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** One page-wide strip, outside the page's padded content column. */
export function Banner({ children, danger = false }: { children: ReactNode; danger?: boolean }) {
  return <div role={danger ? "alert" : "status"} className={cn(
    "flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 text-sm md:px-10",
    danger ? "bg-[var(--tint-danger)]" : "bg-muted",
  )}>{children}</div>;
}
