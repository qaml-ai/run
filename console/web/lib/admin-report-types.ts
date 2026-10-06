/** camelRun dashboard reporting v1. Dates are inclusive calendar dates in time_zone.
 * In a JourneyRow, signup_at, activated_at and acquisition are the account's whole history;
 * last_active_at, events_in_range, payments and amount_minor are the selected dates only.
 * display_name and email are always null: the store holds opaque account ids.
 * Server events have no page: page_host and page_path are null for them.
 * Errors are { error: code } with 400, 401, 404 account_not_found, 410 account_deleted,
 * 422 range_too_long | report_too_large, 503 report_not_configured. */
export type ReportRange = { start_date: string; end_date: string; time_zone: string };
export type ReportRequest = ReportRange & { schema_version: 1; kind: 'signals' | 'journeys' | 'journey'; account_ref?: string; cursor?: string };
export type Acquisition = { source: string | null; medium: string | null; campaign: string | null; landing_path: string | null; handoff_status: string; capture_quality: string };
export type JourneyRow = {
  account_ref: string; display_name: string | null; email: string | null;
  signup_at: string | null; last_active_at: string; events_in_range: number; activated_at: string | null;
  payments: number; amount_minor: number; acquisition: Acquisition; summary: string;
};
export type ReportBase = { schema_version: 1; range: ReportRange; generated_at: string; coverage: { first_event_at: string | null; last_event_at: string | null } };
export type SignalsReport = ReportBase & {
  kind: 'signals'; summary: { signups: number; activations: number; payments: number; paying_accounts: number; amount_minor: number; currency: 'USD' };
  daily: Array<{ date: string; signups: number; activations: number; payments: number; amount_minor: number }>;
};
export type JourneysReport = ReportBase & { kind: 'journeys'; items: JourneyRow[]; next_cursor: string | null };
export type JourneyReport = ReportBase & {
  kind: 'journey'; account: JourneyRow;
  events: Array<{ event_id: string; name: string; occurred_at: string; source_app: 'sales_site' | 'run'; page_host: string | null; page_path: string | null; properties: Record<string, string | number | boolean> }>;
  next_cursor: string | null;
};
export type DashboardReport = SignalsReport | JourneysReport | JourneyReport;
