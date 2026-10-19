import { useMemo, useState, type ReactNode } from "react";
import { AlertCircle, AlertTriangle, ArrowDown, ArrowUp, ChevronDown, CircleCheck, Info, PlugZap, RefreshCw, Search, UserX, XCircle } from "lucide-react";
import type { AdminAccountKind } from "../../../../src/admin-accounts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { change, type OpsError } from "@/lib/ops";
import { cn } from "@/lib/utils";

/** An (i) that explains a figure on hover or focus; the pointer can move into it, so it may hold a link. */
export function Hint({ children, label = "What this means" }: { children: ReactNode; label?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} className="text-muted-foreground hover:text-foreground inline-flex size-4 shrink-0 items-center justify-center align-middle">
          <Info className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 px-3 py-2 text-xs leading-relaxed">{children}</TooltipContent>
    </Tooltip>
  );
}

/** A tab's section: what it answers, in a sentence, over its cards. */
export function Section({ title, hint, description, actions, children }: { title: string; hint?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-10" aria-label={title}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-base font-semibold">{title}{hint && <Hint>{hint}</Hint>}</h2>
          {description && <p className="text-muted-foreground mt-0.5 text-sm">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/**
 * A card of the dashboard. It shows its own loading and failure in place, and keeps what it last showed, dimmed, while
 * it reloads, so the layout never jumps.
 */
export function Panel({ title, hint, description, actions, state, className, children, flush }: {
  title: string; hint?: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string; children?: ReactNode;
  /** Of the figures it shows: whether they are still on their way, and why they could not be read. */
  state?: { loading?: boolean; stale?: boolean; error?: OpsError; ready?: boolean };
  /** Children run to the card's edges (tables). */
  flush?: boolean;
}) {
  const waiting = state && !state.ready;
  return (
    <div className={cn("bg-card flex min-w-0 flex-col border", className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-4 pt-3.5 pb-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-medium">{title}{hint && <Hint>{hint}</Hint>}</h3>
          {description && <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>}
        </div>
        {actions}
      </div>
      <div className={cn("min-w-0 flex-1 transition-opacity", !flush && "px-4 pb-4", state?.stale && "opacity-50")} aria-busy={state?.loading || undefined}>
        {waiting ? (state.error ? <Problem error={state.error} /> : <Skeleton className={cn("h-40 w-full", flush && "mx-4 mb-4 w-[calc(100%-2rem)]")} />) : children}
      </div>
    </div>
  );
}

const PROBLEMS: Record<OpsError, { icon: ReactNode; title: string; body: string }> = {
  sign_in_required: { icon: <AlertCircle />, title: "Your Access session ended", body: "Reload the page to sign in through Cloudflare Access again." },
  not_released: { icon: <PlugZap />, title: "Not on this server yet", body: "This needs a newer release of the runtime than the one answering. It shows once it is deployed." },
  unavailable: { icon: <AlertCircle />, title: "Could not load", body: "The database did not answer. Refresh to try again." },
  not_found: { icon: <UserX />, title: "No such account", body: "It has no account row and nothing in the runtime: it may have been erased." },
};

export function Problem({ error }: { error: OpsError }) {
  const copy = PROBLEMS[error];
  return (
    <div role="status" className="text-muted-foreground flex min-h-40 flex-col items-center justify-center gap-1.5 px-4 py-8 text-center [&>svg]:size-5">
      {copy.icon}
      <p className="text-foreground text-sm font-medium">{copy.title}</p>
      <p className="max-w-sm text-xs">{copy.body}</p>
    </div>
  );
}

/** Nothing to show yet: what will appear here, and when. Never a 0 that was not counted. */
export function Empty({ children, icon, className }: { children: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div className={cn("text-muted-foreground flex min-h-32 flex-col items-center justify-center gap-2 px-4 py-6 text-center text-xs [&_svg]:size-5", className)}>
      {icon}
      <p className="max-w-sm leading-relaxed">{children}</p>
    </div>
  );
}

/**
 * A headline figure: its label, the figure, and how it moved against the period before. Up is good unless `upIsBad`; a
 * fall is ink, never alarm red, which is for problems.
 */
export function Stat({ label, hint, value, compare, compareLabel, detail, upIsBad, tone }: {
  label: string; hint?: ReactNode; value: ReactNode;
  /** The figure and the period before's; null when the period before cannot be compared (it was not recorded). */
  compare?: { current: number; previous: number } | null; compareLabel?: string;
  detail?: ReactNode; upIsBad?: boolean; tone?: "bad";
}) {
  const moved = compare && change(compare.current, compare.previous);
  const good = moved && moved.direction !== "flat" && (moved.direction === "up") !== !!upIsBad;
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground flex items-center gap-1 text-xs">{label}{hint && <Hint>{hint}</Hint>}</dt>
      <dd className={cn("mt-1 text-2xl font-semibold tracking-tight", tone === "bad" && "text-destructive")}>{value}</dd>
      {(compare !== undefined || detail) && (
        <dd className="text-muted-foreground mt-1 text-xs leading-relaxed">
          {compare === null && "Nothing to compare with yet"}
          {compare && (moved ? (
            <>
              <span className={cn("font-medium whitespace-nowrap", good ? "text-foreground" : "text-muted-foreground")}>
                {moved.direction === "up" ? <ArrowUp className="mr-0.5 inline size-3 align-[-1px]" aria-hidden="true" /> : moved.direction === "down" ? <ArrowDown className="mr-0.5 inline size-3 align-[-1px]" aria-hidden="true" /> : null}
                {moved.text}
              </span>{" "}
              {compareLabel ?? "vs the period before"}
            </>
          ) : "Nothing to compare with yet")}
          {compare !== undefined && detail && <span aria-hidden="true"> · </span>}
          {detail}
        </dd>
      )}
    </div>
  );
}

/** A row of stat tiles, split by rules. */
export function Stats({ children, columns = 4 }: { children: ReactNode; columns?: 3 | 4 | 5 }) {
  return (
    <dl className={cn("bg-card grid grid-cols-2 gap-x-6 gap-y-5 border px-4 py-4 sm:px-5",
      columns === 3 ? "lg:grid-cols-3" : columns === 5 ? "lg:grid-cols-5" : "lg:grid-cols-4",
      "lg:[&>div]:border-l lg:[&>div]:pl-6 lg:[&>div:first-child]:border-l-0 lg:[&>div:first-child]:pl-0")}>
      {children}
    </dl>
  );
}

/** A small segmented choice (a range, a view): every option visible, the chosen one pressed. */
export function Choice<T extends string | number>({ options, value, onChange, label }: { options: { value: T; label: string }[]; value: T; onChange: (value: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="bg-muted inline-flex border p-0.5">
      {options.map(option => (
        <button key={String(option.value)} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}
          className={cn("h-7 px-2.5 text-xs whitespace-nowrap transition-colors", option.value === value ? "bg-background text-foreground font-medium shadow-xs" : "text-muted-foreground hover:text-foreground")}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A closed disclosure that opens with an animation: the numbers behind a chart, or the fine print. */
export function Disclosure({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn("mt-3", className)}>
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs">
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden="true" />{label}
      </CollapsibleTrigger>
      <CollapsibleContent><div className="pt-2">{children}</div></CollapsibleContent>
    </Collapsible>
  );
}

/** A chart's numbers as a table, for reading without hovering. */
export function TableView({ columns, rows }: { columns: string[]; rows: (string | number)[][] }) {
  return (
    <Disclosure label="Table view">
      <div className="max-h-72 overflow-auto border">
        <Table>
          <TableHeader><TableRow>{columns.map((column, index) => <TableHead key={column} className={cn("h-8 text-xs", index && "text-right")}>{column}</TableHead>)}</TableRow></TableHeader>
          <TableBody>
            {rows.map((row, index) => (
              <TableRow key={index}>{row.map((cell, column) => <TableCell key={column} className={cn("py-1.5 text-xs", column && "text-right font-mono tabular-nums")}>{cell}</TableCell>)}</TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Disclosure>
  );
}

export type Column<Row> = {
  key: string; label: ReactNode; hint?: ReactNode; align?: "right";
  cell: (row: Row) => ReactNode;
  /** Sorts by this when given; numbers sort high first. */
  sort?: (row: Row) => number | string;
  className?: string;
};

/**
 * A table of rows: sortable by its headers, searchable by `search`, the first `limit` shown until "Show all". A row may
 * open (`onOpen`), by click or keyboard.
 */
export function DataTable<Row>({ rows, columns, rowKey, search, searchLabel = "Search", limit = 10, initialSort, onOpen, empty }: {
  rows: Row[]; columns: Column<Row>[]; rowKey: (row: Row) => string; search?: (row: Row) => string; searchLabel?: string;
  limit?: number; initialSort?: string; onOpen?: (row: Row) => void; empty?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: string; descending: boolean } | undefined>(initialSort ? { key: initialSort, descending: true } : undefined);
  const [all, setAll] = useState(false);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    let list = needle && search ? rows.filter(row => search(row).toLowerCase().includes(needle)) : rows;
    const column = sort && columns.find(column => column.key === sort.key);
    if (column?.sort) {
      const value = column.sort;
      list = [...list].sort((a, b) => {
        const x = value(a), y = value(b);
        const order = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
        return sort!.descending ? -order : order;
      });
    }
    return list;
  }, [rows, query, sort, columns, search]);
  const visible = all ? shown : shown.slice(0, limit);
  return (
    <div>
      {search && rows.length > limit && (
        <div className="relative px-4 pb-3">
          <Search className="text-muted-foreground pointer-events-none absolute top-2 left-6.5 size-3.5" aria-hidden="true" />
          <Input value={query} onChange={event => setQuery(event.target.value)} placeholder={searchLabel} aria-label={searchLabel} className="h-8 max-w-xs pl-7 text-xs" />
        </div>
      )}
      <div className="overflow-x-auto border-t">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map(column => {
                const sorted = sort?.key === column.key;
                return (
                  <TableHead key={column.key} className={cn("h-9 px-2.5 tracking-[0.1em] whitespace-nowrap", column.align === "right" && "text-right", column.className)}
                    aria-sort={sorted ? (sort!.descending ? "descending" : "ascending") : undefined}>
                    <span className="inline-flex items-center gap-1">
                      {column.sort ? (
                        <button type="button" className="hover:text-foreground inline-flex items-center gap-0.5" onClick={() => setSort(sorted ? { key: column.key, descending: !sort!.descending } : { key: column.key, descending: true })}>
                          {column.label}
                          {sorted && (sort!.descending ? <ArrowDown className="size-3" aria-hidden="true" /> : <ArrowUp className="size-3" aria-hidden="true" />)}
                        </button>
                      ) : column.label}
                      {column.hint && <Hint>{column.hint}</Hint>}
                    </span>
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map(row => (
              <TableRow key={rowKey(row)} className={cn(onOpen && "hover:bg-muted/60 cursor-pointer")} tabIndex={onOpen ? 0 : undefined}
                onClick={onOpen && (() => onOpen(row))} onKeyDown={onOpen && (event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(row); } })}>
                {columns.map(column => <TableCell key={column.key} className={cn("px-2.5 py-2 text-xs", column.align === "right" && "text-right font-mono tabular-nums", column.className)}>{column.cell(row)}</TableCell>)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {!shown.length && (empty ?? <Empty>{query ? "Nothing matches that search." : "Nothing here yet."}</Empty>)}
      {shown.length > limit && (
        <div className="border-t px-4 py-2">
          <Button variant="ghost" size="sm" className="text-xs" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${shown.length}`}</Button>
        </div>
      )}
    </div>
  );
}

/** A status that never rests on color alone: an icon and its word. */
export function StatusMark({ status }: { status: "ok" | "warn" | "bad" | "info" }) {
  const marks = {
    ok: { icon: <CircleCheck className="size-4 text-[var(--chart-1)]" aria-hidden="true" />, label: "OK" },
    warn: { icon: <AlertTriangle className="text-foreground size-4" aria-hidden="true" />, label: "Look" },
    bad: { icon: <XCircle className="text-destructive size-4" aria-hidden="true" />, label: "Problem" },
    info: { icon: <Info className="text-muted-foreground size-4" aria-hidden="true" />, label: "Info" },
  }[status];
  return <span className="inline-flex items-center gap-1.5 text-xs">{marks.icon}<span className={cn(status === "bad" && "text-destructive font-medium", status === "warn" && "font-medium")}>{marks.label}</span></span>;
}

export function Spinner() {
  return <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />;
}

const KINDS: Record<AdminAccountKind | "staff", { label: string; variant: "outline" | "secondary" | "default"; hint: string }> = {
  self_serve: { label: "Self-serve", variant: "outline", hint: "Someone signed up for it themselves" },
  operator_made: { label: "Operator-made", variant: "secondary", hint: "An operator made it through the API" },
  operator: { label: "Operator", variant: "default", hint: "An admin tenant of the runtime, such as camelBot" },
  staff: { label: "Team", variant: "secondary", hint: "One of the team's own accounts: not counted in the figures" },
};

/** Who an account is to the operator, in a badge: Self-serve, Operator (camelBot), Operator-made or Team. */
export function KindBadge({ kind, staff }: { kind: AdminAccountKind; staff?: boolean }) {
  const entry = KINDS[staff ? "staff" : kind];
  return <Badge variant={entry.variant} title={entry.hint} className="h-4 px-1.5 text-[0.5625rem] tracking-[0.14em]">{entry.label}</Badge>;
}
export const kindLabel = (kind: AdminAccountKind, staff?: boolean) => KINDS[staff ? "staff" : kind].label;

/** A row of headline figures once they are read: a placeholder of the same height until then, or why they could not be. */
export function Ready({ state, children, height = "h-[104px]" }: { state: { ready: boolean; error?: OpsError }; children: ReactNode; height?: string }) {
  if (state.ready) return <>{children}</>;
  return <div className="bg-card border">{state.error ? <Problem error={state.error} /> : <Skeleton className={cn("m-4 w-[calc(100%-2rem)]", height)} />}</div>;
}
