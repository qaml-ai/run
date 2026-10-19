import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { compact, count, day, percent, type OpsError } from "@/lib/ops";
import { cn } from "@/lib/utils";
import { TableView } from "./parts";
import "./ops.css";

/**
 * The ops dashboard's charts, drawn by hand in SVG and HTML (no chart library). Thin columns with a 4px rounded end on
 * a square baseline, a 2px gap of the card between stacked parts, hairline grid lines and clean round ticks. Colour does
 * one job each: signal blue for the series in focus, ink and a mid grey for the context around it. Every chart has a
 * hover readout (the same on keyboard focus: arrow keys step through it) and a table view.
 */

export const FOCUS = "var(--ops-focus)";
export const INK = "var(--ops-ink)";
export const MID = "var(--ops-mid)";

/** Signal blue `share` (0 to 1) of the way from the card: a one-hue ramp for magnitude, light to strong in either mode. */
export const blueShare = (share: number) => `color-mix(in oklab, var(--ops-focus) ${Math.round(Math.max(0, Math.min(1, share)) * 100)}%, var(--card))`;
/** Five ordered steps of one hue (none used to all used): the card toward blue, then on toward the ink. */
export const ORDINAL = [blueShare(0.24), blueShare(0.5), blueShare(0.76), "var(--ops-focus)", "color-mix(in oklab, var(--ops-focus) 58%, var(--foreground))"];

/** The container's width, as it changes. */
export function useWidth<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Clean ticks from 0: steps of 1, 2 or 5 times a power of ten, about `wanted` of them, a step never under `least`. */
export function ticks(max: number, wanted = 4, least = 1): number[] {
  if (!(max > 0)) return [0, least];
  const rough = max / wanted;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(least, [1, 2, 5, 10].map(factor => factor * power).find(candidate => candidate >= rough) ?? 10 * power);
  return Array.from({ length: Math.ceil(max / step - 1e-9) + 1 }, (_, index) => +(index * step).toPrecision(12));
}

/** A column's outline: its top corners rounded (r), square at the baseline. */
function columnPath(x: number, y: number, width: number, height: number, r: number) {
  const radius = Math.max(0, Math.min(r, width / 2, height));
  return `M${x},${y + height}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + width - radius}Q${x + width},${y} ${x + width},${y + radius}V${y + height}Z`;
}

/**
 * Which mark is read out: the one under the pointer, or, with the chart focused, the one the arrow keys moved to (the
 * newest first). Escape or leaving lets go.
 */
function useActive(length: number, axis: "x" | "y" = "x") {
  const [active, setActive] = useState<number | null>(null);
  const onKeyDown = (event: KeyboardEvent) => {
    if (!length) return;
    const from = active ?? (axis === "x" ? length - 1 : 0);
    const forward = axis === "x" ? "ArrowRight" : "ArrowDown", back = axis === "x" ? "ArrowLeft" : "ArrowUp";
    const next = event.key === forward ? Math.min(length - 1, active === null ? from : from + 1)
      : event.key === back ? Math.max(0, active === null ? from : from - 1)
        : event.key === "Home" ? 0 : event.key === "End" ? length - 1 : event.key === "Escape" ? null : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setActive(next);
  };
  const focus = {
    tabIndex: 0, onKeyDown,
    onFocus: () => setActive(current => current ?? (axis === "x" ? length - 1 : 0)),
    onBlur: () => setActive(null),
    onMouseLeave: () => setActive(null),
  };
  return [active, setActive, focus] as const;
}

const FOCUS_RING = "outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-card";

export interface TipRow { value: string; label: string; color?: string }

/** The hover readout: the value first, strong, its series after; a short line of the series' colour keys it. */
export function ChartTip({ title, rows, style, className }: { title: ReactNode; rows: TipRow[]; style?: CSSProperties; className?: string }) {
  return (
    <div role="presentation" className={cn("bg-popover text-popover-foreground pointer-events-none absolute z-20 min-w-32 border px-2.5 py-1.5 text-xs shadow-md", className)} style={style}>
      <div className="text-muted-foreground mb-1 whitespace-nowrap">{title}</div>
      {rows.map(row => (
        <div key={row.label} className="flex items-center gap-2 whitespace-nowrap leading-5">
          <span aria-hidden="true" className="block h-0.5 w-2.5 shrink-0" style={{ background: row.color ?? "transparent" }} />
          <span className="font-mono font-medium tabular-nums">{row.value}</span>
          <span className="text-muted-foreground">{row.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Which series is which, for two or more: a swatch shaped like the mark, the name in ink. */
export function Legend({ items, className }: { items: { label: string; color: string }[]; className?: string }) {
  return (
    <ul aria-label="Legend" className={cn("text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs", className)}>
      {items.map(item => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span aria-hidden="true" className="block size-2.5 shrink-0" style={{ background: item.color }} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

export interface ColumnSeries { key: string; label: string; color: string }
export interface ColumnDatum {
  key: string;
  /** The readout's title: "Mar 14", "Mar 16 · today, so far". */
  title: string;
  /** The axis's label under it, where there is room. */
  tick: string;
  /** One per series, bottom to top; null is not known (no column, "—" in the readout). */
  values: (number | null)[];
  /** Still going (today): drawn fainter, and said so. */
  partial?: boolean;
  /** More readout lines after the series (a split the column does not draw). */
  more?: TipRow[];
}

const COLUMN_HEIGHT = 184;

/**
 * Columns over a band each (stacked when there are up to three series, the first at the bottom), a y axis of clean
 * ticks, and a readout per band. Counts by default; `format` and `axis` write values and ticks otherwise (dollars).
 */
export function ColumnChart({ series, data, label, format = count, axis = compact, least = 1, height = COLUMN_HEIGHT, table }: {
  series: ColumnSeries[]; data: ColumnDatum[]; label: string; format?: (value: number) => string; axis?: (value: number) => string;
  least?: number; height?: number;
  /** The table view, when it should hold more than the drawn series (a split by sign-in method). */
  table?: { columns: string[]; rows: (string | number)[][] };
}) {
  const [ref, width] = useWidth();
  const [active, setActive, focus] = useActive(data.length);
  const totals = data.map(datum => datum.values.reduce<number>((sum, value) => sum + (value ?? 0), 0));
  const yTicks = ticks(Math.max(0, ...totals), 4, least);
  const top = yTicks.at(-1)!;
  const labelWidth = Math.max(...yTicks.map(tick => axis(tick).length)) * 6.4 + 10;
  const plot = { left: Math.max(26, labelWidth), right: Math.max(40, width - 2), top: 8, bottom: height - 22 };
  const y = (value: number) => plot.bottom - value / top * (plot.bottom - plot.top);
  const band = (plot.right - plot.left) / Math.max(1, data.length);
  const bar = Math.max(1, Math.min(24, band * 0.62, band - 2));
  const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor((plot.right - plot.left) / 62))));
  const many = series.length > 1;
  const readout = active === null ? null : (() => {
    const datum = data[active];
    const rows: TipRow[] = series.map((entry, index) => ({ value: datum.values[index] === null ? "—" : format(datum.values[index]!), label: entry.label, color: entry.color }));
    if (many) rows.push({ value: datum.values.every(value => value === null) ? "—" : format(totals[active]), label: "in all" });
    return { title: datum.title, rows: [...rows, ...(datum.more ?? [])] };
  })();
  const center = active === null ? 0 : plot.left + (active + 0.5) * band;
  const tipSide = center > width / 2 ? { right: width - center + band / 2 + 6 } : { left: center + band / 2 + 6 };
  return (
    <figure className="m-0">
      {many && <Legend className="mb-3" items={series.map(entry => ({ label: entry.label, color: entry.color }))} />}
      <div ref={ref} {...focus} role="group" aria-label={`${label}. Arrow keys read each day.`} className={cn("relative", FOCUS_RING)}>
        {width ? (
          <svg width={width} height={height} aria-hidden="true" className="block overflow-visible">
            {yTicks.map(tick => (
              <g key={tick}>
                <line x1={plot.left} x2={plot.right} y1={y(tick)} y2={y(tick)} stroke={tick ? "var(--ops-grid)" : "var(--ops-axis)"} strokeWidth={1} shapeRendering="crispEdges" />
                <text x={plot.left - 6} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-muted-foreground font-mono text-[10px] tabular-nums">{axis(tick)}</text>
              </g>
            ))}
            {active !== null && <rect x={plot.left + active * band} y={plot.top} width={band} height={plot.bottom - plot.top} fill="var(--accent)" />}
            {data.map((datum, index) => {
              const x = plot.left + index * band + (band - bar) / 2;
              const parts = datum.values.map((value, slot) => ({ value: value ?? 0, slot })).filter(part => part.value > 0);
              let base = 0;
              const labelled = (data.length - 1 - index) % every === 0;
              const tickX = plot.left + (index + 0.5) * band;
              const anchor = tickX - 22 < 0 ? "start" : tickX + 22 > width ? "end" : "middle";
              return (
                <g key={datum.key}>
                  <g opacity={datum.partial ? 0.5 : 1}>
                    {parts.map((part, partIndex) => {
                      const bottom = y(base);
                      base += part.value;
                      const last = partIndex === parts.length - 1;
                      // 2px of the card between stacked parts: every part but the top gives up its upper 2px.
                      const tall = Math.max(0.75, bottom - y(base) - (last ? 0 : 2));
                      return <path key={part.slot} d={columnPath(x, bottom - tall, bar, tall, last ? 4 : 0)} fill={series[part.slot].color} />;
                    })}
                  </g>
                  {labelled && <text x={tickX} y={height - 6} textAnchor={anchor} className="fill-muted-foreground font-mono text-[10px]">{datum.tick}</text>}
                  {/* The whole band is the pointer's target, not just the column. */}
                  <rect x={plot.left + index * band} y={0} width={band} height={plot.bottom} fill="transparent" onMouseEnter={() => setActive(index)} />
                </g>
              );
            })}
          </svg>
        ) : <div style={{ height }} />}
        {readout && <ChartTip title={readout.title} rows={readout.rows} style={{ top: 0, ...tipSide }} />}
        <p className="sr-only" aria-live="polite">{readout ? `${readout.title}: ${readout.rows.map(row => `${row.value} ${row.label}`).join(", ")}` : ""}</p>
      </div>
      <TableView
        columns={table?.columns ?? ["Day (UTC)", ...series.map(entry => entry.label), ...(many ? ["In all"] : [])]}
        rows={table?.rows ?? [...data].reverse().map((datum, index) => {
          const at = data.length - 1 - index;
          return [datum.title, ...datum.values.map(value => value === null ? "—" : format(value)), ...(many ? [format(totals[at])] : [])];
        })}
      />
    </figure>
  );
}

/** A UTC day's column readout title and tick: today's says it is still going. */
export function dayColumn(date: string, incomplete: string) {
  const partial = date === incomplete;
  return { key: date, title: partial ? `${day(date)} · today, so far` : day(date), tick: partial ? "Today" : day(date), partial };
}

export interface BarItem {
  key: string;
  label: ReactNode;
  /** The label as words, for the readout and screen readers. */
  text: string;
  /** Under the label, smaller and muted (a model's provider). */
  sub?: ReactNode;
  value: number;
  /** More figures in their own columns (headed by `columns`), and as words for the readout. */
  extra?: { value: string; label: string }[];
}

/**
 * Horizontal bars of one series, to scale (against `max`, or the largest), each value at the bar's end; more figures in
 * columns beside it, folded under the label on a phone.
 */
export function HBars({ items, label, format = count, unit, max, columns, color = FOCUS, empty }: {
  items: BarItem[]; label: string; format?: (value: number) => string; unit: string; max?: number;
  /** Headings over the value and each extra column. */
  columns?: string[]; color?: string; empty?: ReactNode;
}) {
  const [active, setActive, focus] = useActive(items.length, "y");
  const [ref, width] = useWidth();
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);
  if (!items.length) return <>{empty}</>;
  const top = max ?? Math.max(1, ...items.map(item => item.value));
  const extras = items[0].extra?.length ?? 0;
  // On a phone the extra columns fold under the label, so the grid drops them.
  const narrow = "minmax(0, min(11rem, 40%)) minmax(2.5rem, 1fr) 3.75rem";
  const columnsStyle = { "--bars-narrow": narrow, "--bars-wide": `${narrow}${" 3.75rem".repeat(extras)}` } as CSSProperties;
  const grid = "[grid-template-columns:var(--bars-narrow)] sm:[grid-template-columns:var(--bars-wide)]";
  const row = active === null ? undefined : rowRefs.current[active];
  const item = active === null ? undefined : items[active];
  return (
    <div ref={ref} {...focus} role="group" aria-label={`${label}. Arrow keys read each row.`} className={cn("relative", FOCUS_RING)} style={columnsStyle}>
      {columns && (
        <div className={cn("text-muted-foreground mb-1 hidden gap-x-3 px-1.5 text-[11px] sm:grid", grid)}>
          <span /><span />{columns.map(column => <span key={column} className="text-right">{column}</span>)}
        </div>
      )}
      <ul className="grid">
        {items.map((entry, index) => (
          <li key={entry.key} ref={element => { rowRefs.current[index] = element; }} onMouseEnter={() => setActive(index)}
            className={cn("grid items-center gap-x-3 px-1.5 py-1", grid, active === index && "bg-accent")}>
            <span className="min-w-0 text-xs leading-snug break-words">
              {entry.label}
              {(entry.sub || entry.extra) && (
                <span className="text-muted-foreground block text-[11px]">
                  {entry.sub}
                  {entry.extra && <span className="sm:hidden">{entry.sub ? " · " : ""}{entry.extra.map(extra => `${extra.value} ${extra.label}`).join(" · ")}</span>}
                </span>
              )}
            </span>
            <span aria-hidden="true" className="flex h-3 items-center">
              <span className="block h-3" style={{ width: `${entry.value / top * 100}%`, minWidth: entry.value > 0 ? 2 : 0, background: color, borderRadius: "0 4px 4px 0" }} />
            </span>
            <span className="text-right font-mono text-xs tabular-nums">{format(entry.value)}</span>
            {entry.extra?.map(extra => <span key={extra.label} className="text-muted-foreground hidden text-right font-mono text-xs tabular-nums sm:block">{extra.value}</span>)}
          </li>
        ))}
      </ul>
      {item && row && (
        <ChartTip title={item.text} rows={[{ value: format(item.value), label: unit, color }, ...(item.extra ?? [])]}
          style={{ top: row.offsetTop + row.offsetHeight + 2, left: Math.min(Math.max(0, width - 200), row.offsetLeft + 8) }} />
      )}
      <p className="sr-only" aria-live="polite">{item ? `${item.text}: ${format(item.value)} ${unit}${item.extra ? `, ${item.extra.map(extra => `${extra.value} ${extra.label}`).join(", ")}` : ""}` : ""}</p>
    </div>
  );
}

export interface SplitPart { key: string; label: string; value: number; color: string; detail?: string }

/** One bar split into its parts, to scale, and a legend that carries each part's figure and share. */
export function SplitBar({ parts, label, format = count, unit, columns = 1, inline }: {
  parts: SplitPart[]; label: string; format?: (value: number) => string; unit: string; columns?: 1 | 2;
  /** The legend on one wrapping line (two or three parts), not a list. */
  inline?: boolean;
}) {
  const [active, setActive, focus] = useActive(parts.length);
  const [ref, width] = useWidth();
  const segments = useRef<(HTMLSpanElement | null)[]>([]);
  const sum = parts.reduce((total, part) => total + part.value, 0);
  const shown = parts.filter(part => part.value > 0);
  const part = active === null ? undefined : parts[active];
  const segment = part && segments.current[parts.indexOf(part)];
  const middle = segment ? segment.offsetLeft + segment.offsetWidth / 2 : 0;
  return (
    <div>
      <div ref={ref} {...focus} role="group" aria-label={`${label}: ${parts.map(entry => `${entry.label} ${format(entry.value)}`).join(", ")}. Arrow keys read each part.`} className={cn("relative", FOCUS_RING)}>
        <div className="flex h-3 gap-0.5" aria-hidden="true">
          {shown.map((entry, index) => (
            <span key={entry.key} ref={element => { segments.current[parts.indexOf(entry)] = element; }} onMouseEnter={() => setActive(parts.indexOf(entry))}
              className={cn("block h-full transition-opacity", part && part !== entry && "opacity-60")}
              style={{ flex: `${entry.value} 1 0`, minWidth: 2, background: entry.color, borderRadius: index === shown.length - 1 ? "0 4px 4px 0" : undefined }} />
          ))}
          {!shown.length && <span className="bg-muted block h-full flex-1" />}
        </div>
        {part && (
          <ChartTip title={part.label} rows={[{ value: format(part.value), label: `${unit} · ${percent(part.value, sum)}`, color: part.color }]}
            style={{ top: 18, ...(middle > width / 2 ? { right: Math.max(0, width - middle - 12) } : { left: Math.max(0, middle - 12) }) }} />
        )}
        <p className="sr-only" aria-live="polite">{part ? `${part.label}: ${format(part.value)} ${unit}, ${percent(part.value, sum)}` : ""}</p>
      </div>
      {inline ? (
        <ul className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-xs">
          {parts.map((entry, index) => (
            <li key={entry.key} onMouseEnter={() => setActive(index)} onMouseLeave={() => setActive(null)} className="flex items-center gap-1.5 whitespace-nowrap">
              <span aria-hidden="true" className="block size-2.5" style={{ background: entry.color }} />
              {entry.label}
              <span className="font-mono tabular-nums">{format(entry.value)}</span>
              <span className="text-muted-foreground font-mono tabular-nums">{percent(entry.value, sum)}</span>
            </li>
          ))}
        </ul>
      ) : (
      <ul className={cn("mt-3 grid gap-x-6 gap-y-1.5 text-xs", columns === 2 && "sm:grid-cols-2")}>
        {parts.map((entry, index) => (
          <li key={entry.key} onMouseEnter={() => setActive(index)} onMouseLeave={() => setActive(null)} className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-2">
            <span aria-hidden="true" className="block size-2.5" style={{ background: entry.color }} />
            <span className="min-w-0 truncate">{entry.label}{entry.detail && <span className="text-muted-foreground"> {entry.detail}</span>}</span>
            <span className="whitespace-nowrap"><span className="font-mono tabular-nums">{format(entry.value)}</span><span className="text-muted-foreground inline-block w-11 text-right font-mono tabular-nums">{percent(entry.value, sum)}</span></span>
          </li>
        ))}
      </ul>
      )}
    </div>
  );
}

export interface FunnelStep { key: string; label: string; value: number; previous: number }

/** Each step as a bar of its own, with its share of the step before; the biggest drop says so, with an icon and words. */
export function Funnel({ steps, previousLabel }: { steps: FunnelStep[]; previousLabel: string }) {
  const [active, setActive, focus] = useActive(steps.length, "y");
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);
  const max = Math.max(1, ...steps.map(step => step.value));
  const shares = steps.map((step, index) => index && steps[index - 1].value ? step.value / steps[index - 1].value : null);
  const worst = shares.reduce<number | null>((found, share, index) => share !== null && (found === null || share < shares[found]!) ? index : found, null);
  const step = active === null ? undefined : steps[active];
  return (
    <div {...focus} role="group" aria-label="How far sign-ups got. Arrow keys read each step." className={cn("relative", FOCUS_RING)}>
      <ol className="grid gap-1">
        {steps.map((entry, index) => (
          <li key={entry.key} ref={element => { rowRefs.current[index] = element; }} onMouseEnter={() => setActive(index)} className={cn("grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] items-center gap-x-3 px-1.5 py-1.5 sm:grid-cols-[10rem_minmax(0,1fr)]", active === index && "bg-accent")}>
            <span className="text-xs">{entry.label}</span>
            <span className="flex min-w-0 items-center gap-2.5">
              <span aria-hidden="true" className="block h-4 shrink-0" style={{ width: `calc(${entry.value / max} * (100% - 7.5rem))`, minWidth: entry.value ? 2 : 0, background: FOCUS, borderRadius: "0 4px 4px 0" }} />
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs">
                <span className="font-mono font-medium tabular-nums">{count(entry.value)}</span>
                {shares[index] !== null && <span className="text-muted-foreground whitespace-nowrap">{percent(entry.value, steps[index - 1].value)}</span>}
                {worst === index && steps.length > 2 && (
                  <span className="inline-flex items-center gap-1 font-medium whitespace-nowrap"><AlertTriangle className="size-3" aria-hidden="true" />Biggest drop</span>
                )}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {step && rowRefs.current[active!] && (
        <ChartTip title={step.label} style={{ top: rowRefs.current[active!]!.offsetTop + rowRefs.current[active!]!.offsetHeight + 2, right: 0 }}
          rows={[{ value: count(step.value), label: "this range", color: FOCUS }, { value: count(step.previous), label: previousLabel }]} />
      )}
      <p className="sr-only" aria-live="polite">{step ? `${step.label}: ${count(step.value)}, ${count(step.previous)} ${previousLabel}` : ""}</p>
    </div>
  );
}

export interface CohortRow { week: string; size: number; active: number[] }

/** A cohort cell's fill: the share who came back, on a blue ramp that is full at 60% and above. */
const COHORT_FULL = 0.6;
const cohortFill = (share: number) => blueShare(0.06 + Math.min(1, share / COHORT_FULL) * 0.94);
// Ink on the strongest cells; elsewhere the text colour, which is dark on paper and light on the dark card.
const cohortInk = (share: number) => share / COHORT_FULL >= 0.75 ? "var(--ops-on-focus)" : "var(--foreground)";

/**
 * Do people come back: a row per sign-up week (oldest first), its size, then for each week since, the share of them
 * that did work. The newest cell of each row is a week still going, outlined and in italics.
 */
export function CohortGrid({ cohorts }: { cohorts: CohortRow[] }) {
  const columns = Math.max(0, ...cohorts.map(cohort => cohort.active.length));
  const wrap = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<{ row: number; column: number; left: number; top: number } | null>(null);
  const point = (row: number, column: number, cell: HTMLElement | null) => {
    if (!cell || !wrap.current) return setActive(null);
    const box = wrap.current.getBoundingClientRect(), at = cell.getBoundingClientRect();
    setActive({ row, column, left: at.left - box.left + at.width / 2, top: at.bottom - box.top + 4 });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const now = active ?? { row: cohorts.length - 1, column: 0 };
    const moves: Record<string, [number, number]> = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
    if (event.key === "Escape") return setActive(null);
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    const row = Math.max(0, Math.min(cohorts.length - 1, now.row + (active ? move[0] : 0)));
    const column = Math.max(0, Math.min(cohorts[row].active.length - 1, now.column + (active ? move[1] : 0)));
    point(row, column, wrap.current?.querySelector(`[data-cell="${row}-${column}"]`) ?? null);
  };
  const cohort = active ? cohorts[active.row] : undefined;
  const readout = active && cohort ? {
    title: `Signed up week of ${day(cohort.week)}`,
    value: cohort.active[active.column], last: active.column === cohort.active.length - 1,
    when: active.column === 0 ? "the week they signed up" : `${active.column} ${active.column === 1 ? "week" : "weeks"} later`,
  } : undefined;
  const width = wrap.current?.clientWidth ?? 0;
  return (
    <div>
      <div ref={wrap} className="relative" onMouseLeave={() => setActive(null)}>
        <div tabIndex={0} onKeyDown={onKeyDown} onBlur={() => setActive(null)} role="group"
          aria-label="Share of each sign-up week that did work in each week after. Arrow keys read each cell."
          className={cn("overflow-x-auto overscroll-x-contain", FOCUS_RING)}>
          <table className="w-full border-separate border-spacing-0.5 text-xs">
            <thead>
              <tr className="text-muted-foreground">
                <th scope="col" rowSpan={2} className="bg-card sticky left-0 z-[1] px-1.5 text-left align-bottom font-normal whitespace-nowrap">Week of</th>
                <th scope="col" rowSpan={2} className="px-1.5 text-right align-bottom font-normal whitespace-nowrap">Signed up</th>
                <th scope="colgroup" colSpan={columns} className="px-1 pb-0.5 text-left font-normal whitespace-nowrap">Weeks after signing up</th>
              </tr>
              <tr className="text-muted-foreground">
                {Array.from({ length: columns }, (_, index) => <th key={index} scope="col" className="min-w-10 px-1 py-0.5 text-center font-mono font-normal">{index}</th>)}
              </tr>
            </thead>
            <tbody>
              {cohorts.map((entry, row) => (
                <tr key={entry.week}>
                  <th scope="row" className="bg-card sticky left-0 z-[1] px-1.5 text-left font-normal whitespace-nowrap">{day(entry.week)}</th>
                  <td className="text-muted-foreground px-1.5 text-right font-mono tabular-nums">{count(entry.size)}</td>
                  {Array.from({ length: columns }, (_, column) => {
                    if (column >= entry.active.length) return <td key={column} />;
                    const value = entry.active[column];
                    const going = column === entry.active.length - 1;
                    if (!entry.size) return <td key={column} data-cell={`${row}-${column}`} className="text-muted-foreground py-1.5 text-center">·</td>;
                    const share = value / entry.size;
                    const on = active?.row === row && active.column === column;
                    return (
                      <td key={column} data-cell={`${row}-${column}`} onMouseEnter={event => point(row, column, event.currentTarget)}
                        className={cn("py-1.5 text-center font-mono tabular-nums", going && "italic", on && "outline-2 -outline-offset-2 outline-[var(--foreground)]")}
                        style={{ background: cohortFill(share), color: cohortInk(share), ...(going && !on ? { outline: "1px dashed var(--muted-foreground)", outlineOffset: -1 } : {}) }}>
                        {Math.round(share * 100)}%
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {readout && active && (
          <ChartTip title={readout.title} style={{ top: active.top, ...(active.left > width / 2 ? { right: Math.max(0, width - active.left - 16) } : { left: Math.max(0, active.left - 16) }) }}
            rows={[{ value: percent(readout.value, cohort!.size), label: `${readout.when}${readout.last ? ", so far" : ""}`, color: FOCUS }, { value: `${count(readout.value)} of ${count(cohort!.size)}`, label: "did work" }]} />
        )}
        <p className="sr-only" aria-live="polite">{readout ? `${readout.title}, ${readout.when}: ${count(readout.value)} of ${count(cohort!.size)} did work${readout.last ? " so far" : ""}` : ""}</p>
      </div>
      <div className="text-muted-foreground mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px]">
        <span className="flex items-center gap-1.5">
          0%
          <span aria-hidden="true" className="flex gap-0.5">{[0, 0.15, 0.3, 0.45, 0.6].map(share => <i key={share} className="block h-2.5 w-4" style={{ background: cohortFill(share) }} />)}</span>
          60% or more
        </span>
        <span className="flex items-center gap-1.5">
          <i aria-hidden="true" className="block h-2.5 w-4" style={{ background: cohortFill(0.3), outline: "1px dashed var(--muted-foreground)", outlineOffset: -1 }} />
          <em>Italic, outlined:</em> that week is still going
        </span>
      </div>
      <TableView columns={["Week of", "Signed up", ...Array.from({ length: columns }, (_, index) => index === 0 ? "Same week" : `+${index} wk`)]}
        rows={[...cohorts].reverse().map(entry => [day(entry.week), entry.size, ...Array.from({ length: columns }, (_, column) => column < entry.active.length ? `${count(entry.active[column])}${column === entry.active.length - 1 ? "*" : ""}` : "")])} />
    </div>
  );
}

/** How much of something is used: a short bar on a lighter step of the same blue. */
export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const share = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <span role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} className="block h-1.5 w-14 shrink-0" style={{ background: blueShare(0.22) }}>
      <span className="block h-full" style={{ width: `${share * 100}%`, background: FOCUS }} />
    </span>
  );
}

/** Whether a panel's figures are ready to draw, and why not: the shape `useOps` returns. */
export type PanelState = { ready: boolean; loading: boolean; stale: boolean; error?: OpsError };
