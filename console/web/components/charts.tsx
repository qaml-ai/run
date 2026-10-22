import { useId, type CSSProperties } from "react";
import { formatCost } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * How a series is drawn: the gray ramp (`--chart-3`, `--chart-2`, `--chart-4`), then hatched; Unassigned is an outline.
 * Never a hue: signal blue stays status.
 */
export type SeriesLook = { kind: "ramp"; index: number } | { kind: "outline" };
const RAMP = ["var(--chart-3)", "var(--chart-2)", "var(--chart-4)"];

/** The swatch for a series in a legend: the same look as its bars. */
export function SeriesSwatch({ look, className }: { look: SeriesLook; className?: string }) {
  const style: CSSProperties = look.kind === "outline" ? { border: "1px solid var(--ring)" }
    : look.index < RAMP.length ? { background: RAMP[look.index] }
    : { background: "repeating-linear-gradient(45deg, var(--chart-3) 0 2px, transparent 2px 4px)", border: "1px solid var(--chart-3)" };
  return <span aria-hidden="true" className={cn("inline-block size-2.5 shrink-0", className)} style={style} />;
}

export type Series = { label: string; look: SeriesLook; values: number[] };

/**
 * Daily spend as plain bars in a frame's body: one series, or several stacked (bottom first). Each bar is titled with its
 * day and spend for a hover and a screen reader; the figure is labelled with its range.
 */
export function DailyBars({ days, series, className }: { days: string[]; series: Series[]; className?: string }) {
  const hatch = useId();
  const totals = days.map((_, at) => series.reduce((sum, entry) => sum + Math.max(0, entry.values[at] ?? 0), 0));
  const max = Math.max(0, ...totals);
  const width = 900, height = 180, step = width / Math.max(1, days.length);
  const fill = (look: SeriesLook) => look.kind === "outline" ? "transparent" : look.index < RAMP.length ? RAMP[look.index] : `url(#${hatch})`;
  return (
    <figure className={className}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-44 w-full" role="img" aria-label={`Daily spend, ${days[0]} to ${days.at(-1)}`}>
        <defs><pattern id={hatch} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="4" fill="var(--chart-3)" /></pattern></defs>
        <line x1="0" x2={width} y1={height - 0.5} y2={height - 0.5} stroke="var(--border)" />
        {days.map((day, at) => {
          let y = height;
          const title = series.length > 1
            ? `${day}: ${formatCost(totals[at])} (${series.filter(entry => entry.values[at]).map(entry => `${entry.label} ${formatCost(entry.values[at])}`).join(", ")})`
            : `${day}: ${formatCost(totals[at])}`;
          return (
            <g key={day}>
              <title>{title}</title>
              {series.map(entry => {
                const value = Math.max(0, entry.values[at] ?? 0);
                if (!value || !max) return null;
                const barHeight = Math.max(1.5, (value / max) * (height - 4));
                y -= barHeight;
                return <rect key={entry.label} x={at * step + step * 0.15} width={step * 0.7} y={y} height={barHeight} fill={fill(entry.look)}
                  {...(entry.look.kind === "outline" ? { stroke: "var(--ring)", strokeWidth: 1, vectorEffect: "non-scaling-stroke" } : {})} />;
              })}
            </g>
          );
        })}
      </svg>
      <figcaption className="text-muted-foreground mt-1.5 flex justify-between font-mono text-xs"><span>{days[0]}</span>{days.length > 2 && <span className="hidden sm:inline">{days[Math.floor(days.length / 2)]}</span>}<span>{days.at(-1)}</span></figcaption>
    </figure>
  );
}
