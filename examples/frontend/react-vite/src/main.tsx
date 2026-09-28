import { createRoot } from "react-dom/client";
import { AgentChat } from "@camelai/agent-runtime-react/ui";
import type { ToolRenderProps } from "@camelai/agent-runtime-react";
import "@camelai/agent-runtime-react/styles.css";

// Demo sign-in: a random user per browser (see server.ts).
const user = localStorage.demoUser ??= crypto.randomUUID();

/** get_weather, drawn as a card instead of the default tool card. */
function Weather({ args, result }: ToolRenderProps) {
  const data = result?.data as { temperatureC: number; conditions: string } | undefined;
  return <div style={{ border: "1px solid var(--agent-border)", borderRadius: 12, padding: 12, maxWidth: 240 }}>
    {String(args.city ?? "")}: {data ? `${data.temperatureC}°C, ${data.conditions}` : "…"}
  </div>;
}

createRoot(document.getElementById("root")!).render(
  <AgentChat endpoint="/api/agent" headers={{ "x-demo-user": user }} tools={{ get_weather: Weather }} suggestions={["What's the weather in Lisbon?"]} />,
);
