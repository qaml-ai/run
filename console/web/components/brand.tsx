import type { ReactNode } from "react";
import { DitherAurora, DitherLiquid, TONES } from "@/components/dither";
import { DitherPanel } from "@/components/ui/dither-panel";
import { Eyebrow } from "@/components/ui/eyebrow";
import { useArtTheme } from "@/hooks/use-art-theme";
import { cn } from "@/lib/utils";

/** CamelCool, the display face: only the first-session moments console/DESIGN.md lists use it. */
export const DISPLAY_STYLE = { fontFamily: '"CamelCool", "Silkscreen", monospace', fontWeight: 400 } as const;
/** Silkscreen, the pixel face of eyebrows, badges, table heads and brand buttons. */
export const PIXEL_STYLE = { fontFamily: '"Silkscreen", monospace' } as const;
/** A ground-colored glow for copy that sits on dither art. */
export const GLOW = "[text-shadow:0_0_16px_rgba(246,244,238,0.85)] dark:[text-shadow:0_0_16px_rgba(11,11,12,0.85)]";

/**
 * A first-session moment in place of an empty list: dither art behind an eyebrow, a CamelCool
 * headline, a line of copy and one brand button. `hero` is the taller panel a page leads with.
 */
export function FirstRunPanel({ art, eyebrow, title, children, action, hero = false }: {
  art: "liquid" | "aurora"; eyebrow: string; title: string; children: ReactNode; action: ReactNode; hero?: boolean;
}) {
  const theme = useArtTheme();
  return (
    <DitherPanel
      className={hero ? "min-h-80" : "min-h-64"}
      art={art === "liquid"
        ? <DitherLiquid variant="swell" theme={theme} strength={TONES.ambient} />
        : <DitherAurora variant="curtain" theme={theme} strength={TONES.ambient} />}
    >
      <div className={cn(hero ? "max-w-xl py-10" : "max-w-lg py-8", GLOW)}>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2
          className={cn("break-words leading-[1.05] tracking-[0.04em]", hero ? "mt-4 text-[clamp(1.9rem,3.5vw,3rem)]" : "mt-3 text-[clamp(1.6rem,2.8vw,2.4rem)]")}
          style={DISPLAY_STYLE}
        >
          {title}
        </h2>
        <div className="text-muted-foreground mt-3 max-w-lg text-sm leading-relaxed">{children}</div>
        <div className="mt-5 flex flex-wrap items-center gap-4">{action}</div>
      </div>
    </DitherPanel>
  );
}

/** An error or not-found page: the code in Silkscreen over the bare aurora curtain. */
export function StatusPanel({ code, label, detail, action }: { code: string; label: string; detail: ReactNode; action?: ReactNode }) {
  const theme = useArtTheme();
  return (
    <div className="relative grid min-h-[60dvh] place-items-center overflow-hidden border px-6">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <DitherAurora variant="curtain" theme={theme} strength={TONES.full} className="absolute inset-0" />
      </div>
      <div className={cn("relative z-10 max-w-sm py-12 text-center", GLOW)}>
        <p className="text-foreground text-[clamp(3rem,8vw,5rem)] leading-none" style={PIXEL_STYLE}>{code}</p>
        <p className="text-muted-foreground mt-4 text-[10px] uppercase tracking-[0.3em]" style={PIXEL_STYLE}>{label}</p>
        <p className="text-muted-foreground mt-3 text-xs">{detail}</p>
        {action && <div className="mt-6">{action}</div>}
      </div>
    </div>
  );
}
