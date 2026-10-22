/** Wall-clock schedules. Sunday is 0. A repeated DST hour runs once; a missing hour is skipped. */
export interface Calendar { time: string; timeZone: string; daysOfWeek?: number[] }
export function calendarInput(value: any): Calendar {
  if (!value || typeof value !== "object" || typeof value.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw new Error("calendar.time must be HH:MM (00:00–23:59)");
  if (typeof value.timeZone !== "string" || !value.timeZone) throw new Error("calendar.timeZone must be an IANA time zone");
  try { new Intl.DateTimeFormat("en-US", { timeZone: value.timeZone }).format(); } catch { throw new Error("calendar.timeZone must be an IANA time zone"); }
  if (value.daysOfWeek !== undefined && (!Array.isArray(value.daysOfWeek) || !value.daysOfWeek.length || value.daysOfWeek.some((d: unknown) => !Number.isInteger(d) || Number(d) < 0 || Number(d) > 6) || new Set(value.daysOfWeek).size !== value.daysOfWeek.length)) throw new Error("calendar.daysOfWeek must contain distinct weekdays, Sunday 0 through Saturday 6");
  return { time: value.time, timeZone: value.timeZone, ...(value.daysOfWeek ? { daysOfWeek: [...value.daysOfWeek].sort() } : {}) };
}
export function nextCalendar(calendar: Calendar, after: number): number {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: calendar.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const wall = (ms: number) => {
    const p = Object.fromEntries(fmt.formatToParts(ms).map(p => [p.type, p.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  };
  const start = new Date(wall(after)); start.setUTCHours(0, 0, 0, 0);
  const [hour, minute] = calendar.time.split(":").map(Number);
  for (let day = 0; day < 15; day++) {
    const date = new Date(start.getTime() + day * 86_400_000);
    if (calendar.daysOfWeek && !calendar.daysOfWeek.includes(date.getUTCDay())) continue;
    const target = date.getTime() + hour * 3_600_000 + minute * 60_000;
    const offsets = new Set<number>();
    for (let h = -36; h <= 36; h += 6) { const sample = target + h * 3_600_000; offsets.add(wall(sample) - sample); }
    const candidates = [...offsets].map(offset => target - offset).filter(ms => wall(ms) === target).sort((a, b) => a - b);
    if (candidates.length && candidates[0] > after) return candidates[0];
  }
  throw new Error("No calendar occurrence found");
}

/** A fixed occurrence date, unchanged on retry; the model must not infer it from search results. */
export function calendarPrompt(text: string, calendar: Calendar, dueAt: number): string {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: calendar.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(dueAt);
  return `${text}\n\nScheduled occurrence: ${new Date(dueAt).toISOString()}. The local edition date is ${date} in ${calendar.timeZone}. Use this date for this run and its report files; do not infer the date from source timestamps.`;
}
