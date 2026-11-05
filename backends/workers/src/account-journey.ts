import type { Sql } from "./postgres.ts";
export type JourneyMethod = "github" | "google" | "password";
/** Optional analytics hook. Account creation and signup-source SQL do not depend on it. */
export interface Journey {
  browser(request: Request): unknown;
  consent(request: Request): string;
  authStarted(event: { method: JourneyMethod; surface: string; browser: unknown }): Promise<void>;
  accountCreated(sql: Sql, event: { tenant: string; method: JourneyMethod; surface: string; browser: unknown; email?: string }): Promise<void>;
  signedIn(event: { tenant: string; method: JourneyMethod; surface: string; browser: unknown; email?: string }): Promise<void>;
  signedOut(event: { tenant: string; browser: unknown }): Promise<void>;
}
