/**
 * Get Help: what the console sends to POST /v1/help, shared by the console and the server.
 * Automatic context is bounded on purpose: route templates, never IDs, queries, bodies or error text.
 */
export const HELP_CATEGORIES = ["bug", "question", "feature", "billing", "other"] as const;
export const HELP_IMPACTS = ["minor", "degraded", "blocking"] as const;
export type HelpCategory = typeof HELP_CATEGORIES[number];
export type HelpImpact = typeof HELP_IMPACTS[number];

export const HELP_CATEGORY_LABELS: Record<HelpCategory, string> = {
  bug: "Bug or error", question: "How-to question", feature: "Feature request", billing: "Billing & credit", other: "Other",
};
export const HELP_IMPACT_LABELS: Record<HelpImpact, string> = { minor: "Minor", degraded: "Degraded", blocking: "Blocking" };
export const HELP_IMPACT_DESCRIPTIONS: Record<HelpImpact, string> = {
  minor: "Cosmetic or occasional", degraded: "Works, with a workaround", blocking: "Can't complete the task; no workaround",
};

export const HELP_LIMITS = { description: 4000, email: 254, agentId: 128, requestId: 128, page: 200, failures: 5 } as const;

/** One console API call that failed, as the console reports it. */
export interface HelpFailure { method: string; path: string; status: number; at: string }
export interface HelpSubmission {
  /** A UUID the console makes once per submission and keeps for retries of it. */
  submissionId: string;
  email: string;
  category: HelpCategory;
  /** Required for bugs; ignored for other categories. */
  impact?: HelpImpact;
  description: string;
  agentId?: string;
  requestId?: string;
  context?: { page?: string; viewport?: string; timezone?: string; build?: string; failures?: HelpFailure[] };
}
export type HelpResponse = { success: true; reference: string };
/**
 * GET /v1/help. `replyEmails` are the tenant's verified billing addresses (suppressed ones left out), oldest first.
 * When there are any, a new submission must use one of them (else 400 INVALID_REQUEST); a retry keeps its address.
 */
export interface HelpAvailability { enabled: boolean; replyEmails: string[] }
/**
 * Error codes the console acts on (the body is `{ error, code }`):
 * HELP_DELIVERY_FAILED (503) and HELP_IN_PROGRESS (409): retry the same submission after Retry-After;
 * HELP_PAYLOAD_MISMATCH (409) and HELP_RECIPIENT_SUPPRESSED (422): change it and submit with a new submissionId
 * (a suppressed saved address also leaves `replyEmails`, so reload it);
 * RATE_LIMITED (429): wait Retry-After seconds; INVALID_REQUEST (400): fix the field.
 */
export type HelpErrorCode = "HELP_DELIVERY_FAILED" | "HELP_IN_PROGRESS" | "HELP_PAYLOAD_MISMATCH" | "HELP_RECIPIENT_SUPPRESSED" | "RATE_LIMITED" | "INVALID_REQUEST";

/** The console API routes a help request may report, as templates. Auth and help routes are left out. */
export const HELP_ROUTE_TEMPLATES = [
  "/v1/me", "/v1/models", "/v1/providers", "/v1/providers/:provider/key",
  "/v1/agents", "/v1/agents/:id", "/v1/agents/:id/prompt", "/v1/agents/:id/abort", "/v1/agents/:id/history",
  "/v1/agents/:id/state", "/v1/agents/:id/events", "/v1/agents/:id/configuration", "/v1/agents/:id/requests/:requestId",
  "/v1/agents/:id/mounts", "/v1/agents/:id/schedules", "/v1/agents/:id/inputs",
  "/v1/definitions", "/v1/definitions/:id", "/v1/channels", "/v1/channels/:id",
  "/v1/volumes", "/v1/volumes/:id", "/v1/volumes/:id/snapshots", "/v1/volumes/:id/snapshots/:snapshotId",
  "/v1/volumes/:id/files", "/v1/volumes/:id/files/*", "/v1/volumes/:id/links",
  "/v1/tokens", "/v1/tokens/:id", "/v1/oauth/grants", "/v1/oauth/grants/:id", "/v1/usage",
  "/v1/billing", "/v1/billing/ledger", "/v1/billing/checkout", "/v1/billing/portal", "/v1/billing/payment-method",
  "/v1/billing/alerts", "/v1/billing/alerts/recipients", "/v1/billing/alerts/recipients/:id", "/v1/billing/alerts/recipients/:id/resend",
  "/v1/billing/auto-topup", "/v1/billing/auto-topup/quote", "/v1/billing/auto-topup/enable", "/v1/billing/auto-topup/disable",
  "/v1/billing/auto-topup/refresh", "/v1/billing/auto-topup/retry",
] as const;
export const HELP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** The template a console API path matches (query and fragment ignored), or undefined to leave the call out. */
export function helpRouteTemplate(path: string): string | undefined {
  const segments = path.split(/[?#]/, 1)[0].split("/");
  return HELP_ROUTE_TEMPLATES.find(template => {
    const parts = template.split("/");
    if (parts.at(-1) === "*") return segments.length > parts.length - 1 && parts.slice(0, -1).every((part, i) => matches(part, segments[i]));
    return parts.length === segments.length && parts.every((part, i) => matches(part, segments[i]));
  });
}
const matches = (part: string, segment: string) => part.startsWith(":") ? segment.length > 0 : part === segment;
