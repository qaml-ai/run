import { Agents, schema, tool } from "@camelai/agent-runtime";

// A real tool: runs here, in this process, and calls Open-Meteo (free, no key).
const weather = tool({
  description: "Current weather and a 7-day forecast for a city",
  input: schema.Object({ city: schema.String() }),
  execute: async ({ city }) => {
    const geo = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`)).json();
    const place = geo.results?.[0];
    if (!place) throw new Error(`No place called ${city}`);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      "&current=temperature_2m,precipitation,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=7&timezone=auto";
    return { place: `${place.name}, ${place.country}`, ...(await (await fetch(url)).json()) };
  },
});

const agents = new Agents();
const agent = await agents.upsert("stream-tool-ts", {
  model: "openrouter/openai/gpt-6-luna",
  instructions: "You are a concise weather assistant. Use the weather tool; never guess.",
  tools: { weather },
});

const question = process.argv.slice(2).join(" ") || "Do I need an umbrella in Lisbon or Oslo this weekend?";
for await (const part of agent.stream(question)) {
  if (part.type === "text") process.stdout.write(part.text);
  if (part.type === "tool_call") console.log(`→ ${part.name}(${JSON.stringify(part.arguments)})`);
}
console.log();
await agents.close();
