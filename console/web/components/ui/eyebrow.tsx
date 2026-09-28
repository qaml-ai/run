import type { ReactNode } from "react";

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p
      className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground"
      style={{ fontFamily: '"Silkscreen", monospace' }}
    >
      {children}
    </p>
  );
}
