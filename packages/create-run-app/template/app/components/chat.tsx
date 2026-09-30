"use client";

import { AgentChat } from "@camelai/run-react/ui";
import type { ToolRenderProps } from "@camelai/run-react";

/** A tool call rendered with your own component ("generative UI"): here, get_weather as a card. */
function WeatherCard({ args, state, result }: ToolRenderProps) {
  const data = result?.data as { city: string; temperatureC: number; conditions: string } | undefined;
  return (
    <div style={{ border: "1px solid var(--agent-border)", borderRadius: 12, padding: "12px 16px", maxWidth: 280 }}>
      <div style={{ fontSize: 13, color: "var(--agent-muted-fg)" }}>Weather · {String(args.city ?? "…")}</div>
      {data ? (
        <div style={{ fontSize: 28, fontWeight: 600 }}>{data.temperatureC}°C <span style={{ fontSize: 15, fontWeight: 400 }}>{data.conditions}</span></div>
      ) : (
        <div style={{ color: "var(--agent-muted-fg)" }}>{state === "error" ? "Could not get the weather." : "Checking…"}</div>
      )}
    </div>
  );
}

export function Chat() {
  return (
    <AgentChat
      endpoint="/api/agent"
      tools={{ get_weather: WeatherCard }}
      suggestions={["What's the weather in Lisbon?", "Write a haiku about deploys", "Explain SSE in two sentences"]}
      style={{ flex: 1, minHeight: 0 }}
    />
  );
}
