import assert from "node:assert/strict";
import { Sim } from "./sim.ts";

export async function prompt(sim: Sim, node: string, agent: string, text: string) {
  const accepted = await sim.call(node, `/v1/agents/${agent}/prompt`, { body: { text } });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.json));
  return accepted.json.id as string;
}
export const outcome = (sim: Sim, node: string, agent: string, id: string) =>
  sim.until(async () => { const record = (await sim.call(node, `/v1/agents/${agent}/requests/${id}`)).json; return record?.state === "completed" && record; }, `request ${id}`);
