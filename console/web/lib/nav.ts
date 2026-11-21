import {
  BarChart3,
  Bot,
  CreditCard,
  FileCode,
  HardDrive,
  KeyRound,
  LayoutDashboard,
  MessageCircle,
  Rocket,
  Settings,
  SlidersHorizontal,
  Webhook,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  sections: string[];
}

/** Get started sits above the groups while a path is in progress, then beside Docs. */
export const START: NavItem = { to: "start", label: "Get started", icon: Rocket, sections: ["start", "quickstart"] };

/** Primary runtime views. */
export const PRIMARY_NAV: NavItem[] = [
  { to: "", label: "Overview", icon: LayoutDashboard, sections: [""] },
  { to: "agents", label: "Agents", icon: Bot, sections: ["agents"] },
  { to: "definitions", label: "Definitions", icon: FileCode, sections: ["definitions"] },
  { to: "usage", label: "Usage", icon: BarChart3, sections: ["usage"] },
];

/** Account-wide pages. */
export const ACCOUNT_NAV: NavItem[] = [
  { to: "channels", label: "Channels", icon: MessageCircle, sections: ["channels"] },
  { to: "webhooks", label: "Webhooks", icon: Webhook, sections: ["webhooks"] },
  { to: "repos", label: "Repositories", icon: HardDrive, sections: ["repos"] },
  { to: "tokens", label: "API keys", icon: KeyRound, sections: ["tokens"] },
  { to: "models", label: "Models & keys", icon: SlidersHorizontal, sections: ["models"] },
  { to: "billing", label: "Billing", icon: CreditCard, sections: ["billing"] },
  { to: "account", label: "Settings", icon: Settings, sections: ["account"] },
];

export const NAV: NavItem[] = [START, ...PRIMARY_NAV, ...ACCOUNT_NAV];

/** Places that group several pages show them as link tabs; each page keeps its own URL. */
export const TABS: Record<string, { to: string; label: string }[]> = {};

export const groupOf = (section: string) => NAV.find(item => item.sections.includes(section));

/**
 * Where an old or shorthand URL now lives, or undefined when it is current.
 * `path` is relative to /console/, `search` includes its `?`.
 */
export function redirectFor(path: string, search: string): string | undefined {
  const [section, id] = path.split("/");
  const query = new URLSearchParams(search);
  if ((section === "settings" || section === "telemetry") && !id) return withQuery("account", query);
  if (section === "overview" && !id) return withQuery("", query);
  if (section === "volumes") return withQuery(id ? `repos/${id}` : "repos", query);
  if (section === "inbox") return withQuery("agents", query);
  if (section === "workspaces" || section === "computers") return withQuery("", query);
  return undefined;
}

/** The browser tab's title: the page's place, then camelRun. */
export function documentTitle(section: string, home = false) {
  const place = home ? START.label : (groupOf(section) ?? groupOf("agents"))!.label;
  return `${place} · camelRun`;
}

const withQuery = (path: string, query: URLSearchParams) => (query.toString() ? `${path}?${query}` : path);
