import type { ReportRange, ReportRequest } from "./admin-report-types.ts";
export const TIME_ZONE = "America/Chicago";
export function today(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
function dateValue(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const time = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : NaN;
}
export function rangeError(range: ReportRange): string | null {
  const a = dateValue(range.start_date), b = dateValue(range.end_date);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "Choose a valid start and end date.";
  if (a > b) return "The end date must be on or after the start date.";
  if ((b - a) / 86400000 >= 366) return "Choose up to 366 calendar days at a time.";
  if (range.time_zone !== TIME_ZONE) return "Dates use Central Time (America/Chicago).";
  return null;
}
export function presetRange(preset: string, date = today()): ReportRange {
  const end = new Date(date + "T00:00:00Z"), start = new Date(end);
  if (preset === "yesterday") { start.setUTCDate(start.getUTCDate()-1); end.setUTCDate(end.getUTCDate()-1); }
  if (preset === "week") start.setUTCDate(start.getUTCDate() - ((start.getUTCDay()+6)%7));
  if (preset === "month") start.setUTCDate(1);
  if (preset === "last-month") { start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth()-1); end.setUTCDate(0); }
  return { start_date: start.toISOString().slice(0,10), end_date: end.toISOString().slice(0,10), time_zone: TIME_ZONE };
}
export function parseReportRequest(input: unknown): ReportRequest | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const r = input as ReportRequest;
  if (Object.keys(r).some(k => !["schema_version","kind","start_date","end_date","time_zone","account_ref","cursor"].includes(k))) return null;
  if (r.schema_version !== 1 || !["signals","journeys","journey"].includes(r.kind) || rangeError(r)) return null;
  if (r.kind === "journey" ? typeof r.account_ref !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(r.account_ref) : r.account_ref !== undefined) return null;
  if (r.cursor !== undefined && (r.kind === "signals" || typeof r.cursor !== "string" || !/^[A-Za-z0-9_-]{1,300}$/.test(r.cursor))) return null;
  return r;
}
