import { Bot, KeyRound, MessageCircle, Rocket, Settings } from "lucide-react";

/** Five places; each owns the pages under it (old URLs keep working), and pages in a group share its tabs. */
export const NAV = [
  { to: "start", label: "Get started", icon: Rocket, sections: ["start", "quickstart"] },
  { to: "agents", label: "Agents", icon: Bot, sections: ["agents", "definitions", "volumes"] },
  { to: "channels", label: "Channels", icon: MessageCircle, sections: ["channels"] },
  { to: "tokens", label: "API keys", icon: KeyRound, sections: ["tokens"] },
  { to: "models", label: "Settings", icon: Settings, sections: ["models", "usage", "billing", "telemetry", "account"] },
];
export const TABS: Record<string, { to: string; label: string }[]> = {
  agents: [{ to: "agents", label: "Agents" }, { to: "definitions", label: "Definitions" }, { to: "volumes", label: "Volumes" }],
  models: [{ to: "models", label: "Models & keys" }, { to: "usage", label: "Usage" }, { to: "billing", label: "Billing" }, { to: "telemetry", label: "Telemetry" }, { to: "account", label: "Account" }],
};
export const groupOf = (section: string) => NAV.find(item => item.sections.includes(section));
