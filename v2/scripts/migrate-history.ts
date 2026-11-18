import { pathToFileURL } from "node:url";
import type { HistoryPage } from "../../clients/typescript.ts";
import { CamelRun, type AgentHandle } from "../sdk/src/index.ts";

export async function migrateHistory(v1Url: string, v1Key: string, sourceAgent: string, target: AgentHandle, previous?: string) {
  const url = new URL(`/v1/agents/${encodeURIComponent(sourceAgent)}/history`, v1Url);
  const source = url.href;
  const messages: unknown[] = [];
  let total: number | undefined;
  for (;;) {
    url.searchParams.set("after", String(messages.length));
    url.searchParams.set("limit", "100");
    const response = await fetch(url, { headers: { Authorization: `Bearer ${v1Key}` } });
    if (!response.ok) throw new Error(`v1 history request failed with HTTP ${response.status}`);
    const page = await response.json() as HistoryPage;
    total ??= page.total;
    if (page.truncated || page.total !== total) throw new Error("The v1 history changed during the copy or has a gap");
    for (const { index, message } of page.entries) {
      if (index !== messages.length) throw new Error(`Missing v1 message ${messages.length}`);
      messages.push(message);
    }
    if (messages.length === total && page.entries.length === 0) break;
    if (!page.entries.length || page.nextAfter !== messages.length || messages.length > total) {
      throw new Error("The v1 history cursor did not advance as expected");
    }
  }
  return target.importV1History({ source, messages, previous });
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [sourceAgent, destinationAgent, previous, ...extra] = process.argv.slice(2);
  if (!sourceAgent || !destinationAgent || extra.length) {
    throw new Error("Usage: node --experimental-strip-types v2/scripts/migrate-history.ts <v1-agent> <v2-agent> [previous-receipt]");
  }
  const v2 = new CamelRun({ baseUrl: env("V2_URL"), apiKey: env("V2_API_KEY") });
  try {
    const destination = await v2.agents.get(destinationAgent);
    console.log(JSON.stringify(await migrateHistory(env("V1_URL"), env("V1_API_KEY"), sourceAgent, destination, previous)));
  } finally {
    await v2.close();
  }
}
