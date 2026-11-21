import type { ReactNode } from "react";
import { DISPLAY_STYLE, GLOW } from "@/components/brand";
import { DitherLiquid, TONES } from "@/components/dither";
import { Eyebrow } from "@/components/ui/eyebrow";
import { RunLogo } from "@/components/ui/logo";
import { useArtTheme } from "@/hooks/use-art-theme";
import { cn } from "@/lib/utils";

/** Sign-in: the form on the left; from lg, camelRun's dithered current and headline on the right. */
export function AuthLayout({ children }: { children: ReactNode }) {
  const theme = useArtTheme();
  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex justify-center md:justify-start">
          <RunLogo className="text-lg" />
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-xs">{children}</div>
        </div>
      </div>
      <div className="relative hidden overflow-hidden border-l bg-background lg:block">
        <DitherLiquid variant="current" theme={theme} strength={TONES.ambient} className="absolute inset-0" />
        <div className={cn("absolute inset-0 z-10 flex flex-col justify-end gap-3 p-10 xl:p-14", GLOW)}>
          <Eyebrow>CAMELRUN · CONSOLE</Eyebrow>
          <h2
            className="text-foreground max-w-md text-[clamp(1.75rem,4vw,2.75rem)] leading-[1.05] font-normal tracking-[0.04em]"
            style={DISPLAY_STYLE}
          >
            Durable agents. Hosted.
          </h2>
        </div>
      </div>
    </div>
  );
}
