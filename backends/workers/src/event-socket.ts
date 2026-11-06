import { readableFrame, type BrowserClaims } from "./browser-tokens.ts";
import { visibleEvent } from "./event-visibility.ts";

/** Only routing and verified projection policy are retained through hibernation. */
export type EventSubscription = {
  type: "camel.application" | "camel.watcher";
  subagents?: boolean;
  request?: string;
  connection?: string;
  serving?: boolean;
  initialized?: boolean;
  browser?: Pick<BrowserClaims, "scopes" | "events" | "redact" | "exp">;
};

export function subscribedEvent(subscription: EventSubscription, value: unknown, now = Date.now()): unknown {
  if (subscription.browser && subscription.browser.exp <= now) return undefined;
  if (!visibleEvent(value, subscription.subagents === true)) return undefined;
  const event = value as { type?: string; requestId?: string; id?: string };
  if (subscription.request && (event.type === "event" ? event.requestId !== subscription.request :
      event.type === "response" ? event.id !== subscription.request : false)) return undefined;
  return subscription.browser ? readableFrame(subscription.browser as BrowserClaims, value) : value;
}
