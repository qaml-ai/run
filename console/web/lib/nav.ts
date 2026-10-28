import { BarChart3, Bot, Boxes, CreditCard, FileCode, HardDrive, KeyRound, LayoutDashboard, MessageCircle, Monitor, Rocket, Settings, SlidersHorizontal, type LucideIcon } from "lucide-react";

export interface NavItem { to: string; label: string; icon: LucideIcon; sections: string[] }

/** Get started sits above the groups while a path is in progress, then beside Docs. */
export const START: NavItem = { to: "start", label: "Get started", icon: Rocket, sections: ["start", "quickstart"] };
/** What the workspace switcher scopes: only what the server scopes (agents, definitions and their spend). */
export const WORKSPACE_NAV: NavItem[] = [
  // Home: Overview for an account with agents (Get started before its first).
  { to: "", label: "Overview", icon: LayoutDashboard, sections: [""] },
  { to: "agents", label: "Agents", icon: Bot, sections: ["agents"] },
  { to: "definitions", label: "Definitions", icon: FileCode, sections: ["definitions"] },
  { to: "usage", label: "Usage", icon: BarChart3, sections: ["usage"] },
  { to: "workspaces", label: "Workspaces", icon: Boxes, sections: ["workspaces"] },
];
/** Account-wide pages: they never change with the switcher. */
export const ACCOUNT_NAV: NavItem[] = [
  { to: "channels", label: "Channels", icon: MessageCircle, sections: ["channels"] },
  { to: "volumes", label: "Volumes", icon: HardDrive, sections: ["volumes"] },
  { to: "computers", label: "Computers", icon: Monitor, sections: ["computers"] },
  { to: "tokens", label: "API keys", icon: KeyRound, sections: ["tokens"] },
  { to: "models", label: "Models & keys", icon: SlidersHorizontal, sections: ["models"] },
  { to: "billing", label: "Billing", icon: CreditCard, sections: ["billing"] },
  { to: "account", label: "Settings", icon: Settings, sections: ["account"] },
];
export const NAV: NavItem[] = [START, ...WORKSPACE_NAV, ...ACCOUNT_NAV];
/** Places that group several pages show them as link tabs; each page keeps its own URL. */
export const TABS: Record<string, { to: string; label: string }[]> = {};
export const groupOf = (section: string) => NAV.find(item => item.sections.includes(section));

const SCOPED = new Set(WORKSPACE_NAV.flatMap(item => item.sections));
/** Whether a page (its first path segment) follows the workspace switcher. */
export const isScoped = (section: string) => SCOPED.has(section);

/**
 * Where an old or shorthand URL now lives, or undefined when it is current. `path` is relative to /console/, `search`
 * includes its `?`. Returns the path (with query) to replace it with.
 */
export function redirectFor(path: string, search: string): string | undefined {
  const [section, id] = path.split("/");
  const query = new URLSearchParams(search);
  // Settings was trace export and the account; trace export is gone.
  if ((section === "settings" || section === "telemetry") && !id) return withQuery("account", query);
  if (section === "overview" && !id) return withQuery("", query);
  // Usage's workspace filter was ?workspaceId= before the switcher.
  if (section === "usage" && query.has("workspaceId")) {
    const ws = query.get("workspaceId")!;
    query.delete("workspaceId");
    if (ws && ws !== "all") query.set("ws", ws); else query.delete("ws");
    return withQuery(path, query);
  }
  // A workspace's settings page selects that workspace.
  if (section === "workspaces" && id && query.get("ws") !== id) { query.set("ws", id); return withQuery(path, query); }
  return undefined;
}

/**
 * The browser tab's title: the page's place, the workspace a scoped page shows (`ws`: its name, or "Unassigned"), then
 * camelRun. `section` is the page's first path segment.
 */
export function documentTitle(section: string, ws: string | undefined, workspaces: { id: string; name: string }[] | undefined, home = false) {
  const place = home ? START.label : (groupOf(section) ?? groupOf("agents"))!.label;
  const scope = !home && isScoped(section) && ws ? (ws === "unassigned" ? "Unassigned" : workspaces?.find(workspace => workspace.id === ws)?.name) : undefined;
  return [place, scope, "camelRun"].filter(Boolean).join(" · ");
}

const withQuery = (path: string, query: URLSearchParams) => query.toString() ? `${path}?${query}` : path;
