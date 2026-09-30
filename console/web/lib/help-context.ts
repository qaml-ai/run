import { HELP_LIMITS, HELP_METHODS, helpRouteTemplate, type HelpFailure, type HelpSubmission } from "../../../shared/help-contract.ts";

// Memory only. A generation also excludes requests that finish after the tenant changes.
let tenant: string | undefined;
let generation = 0;
let failures: HelpFailure[] = [];

export function setHelpTenant(next: string | undefined) {
  if (tenant === next) return;
  tenant = next;
  generation++;
  failures = [];
}
export const helpRequestScope = () => tenant ? generation : undefined;

export function recordHelpFailure(scope: number | undefined, method: string, path: string, status: number) {
  if (scope === undefined || scope !== generation || !tenant) return;
  const route = helpRouteTemplate(path);
  method = method.toUpperCase();
  if (!route || !HELP_METHODS.includes(method as never)) return;
  failures = [...failures, { method, path: route, status, at: new Date().toISOString() }].slice(-HELP_LIMITS.failures);
}

/** Only the path, never query/fragment, and no response text, headers or request bodies. */
export function helpContext(): HelpSubmission["context"] {
  return {
    page: location.pathname.slice(0, HELP_LIMITS.page),
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    build: import.meta.env.VITE_CONSOLE_BUILD ?? "unknown",
    failures: failures.map(failure => ({ ...failure })),
  };
}

const emailKey = (tenant: string) => `camelrun:help-email:${tenant}`;
export function lastHelpEmail(tenant: string) {
  try { return localStorage.getItem(emailKey(tenant))?.slice(0, HELP_LIMITS.email) ?? ""; } catch { return ""; }
}
export function rememberHelpEmail(tenant: string, email: string) {
  try { localStorage.setItem(emailKey(tenant), email); } catch { /* Storage may be disabled. Sending still works. */ }
}
