import { createHash } from 'node:crypto';
import { Inputs, inputView, answerInput, mayAnswer, expiryAnswer, decisionNotice, type InputRow, type Answer, type Responder } from './decision-inputs.ts';
import { database } from './postgres.ts';
import { HttpError } from './errors.ts';
import { actorInput } from './security-policy.ts';
import { senderInput } from './sender.ts';
import { canonical } from '../../../shared/durable-json.ts';
import type { AgentRuntime } from './agent-runtime.ts';

export const decisionInputs = (agent: AgentRuntime) => new Inputs({ db: database(agent.env) });
export async function deliverDecisions(agent: AgentRuntime, rows: InputRow[], admitted = false) {
  if (!rows.length) return [];
  const conf = await agent.config(), store = decisionInputs(agent), requests = [];
  for (const [id, pending] of await store.deliveries(conf.id)) {
    const submit = admitted ? agent.admit.bind(agent) : agent.submit.bind(agent);
    const result = await submit({ id, method: 'prompt', params: { text: decisionNotice(pending), allowDisconnected: true } }, {
      source: { kind: 'agent', agentId: conf.id, name: 'decision inbox' }, root: conf.id, costUsd: 0, metadata: { kind: 'message', to: 'decision' },
    });
    await store.delivered(id);
    requests.push(result);
  }
  return requests;
}
export async function answerDecisions(agent: AgentRuntime, answers: { id: string; body: any }[], via: Responder['via']) {
  const store = decisionInputs(agent), conf = await agent.config();
  if (!answers.length || answers.length > 100 || new Set(answers.map(a => a.id)).size !== answers.length) throw new HttpError(400, 'Answer 1 to 100 different inputs');
  const checked: { input: InputRow; answer: Answer }[] = [];
  for (const entry of answers) {
    const input = await store.get(entry.id);
    if (!input || input.agent !== conf.id || input.tenant !== conf.tenantId || input.blocking !== false) throw new HttpError(404, 'Unknown decision');
    const by = { via, ...(entry.body.actor !== undefined ? { actor: actorInput(entry.body.actor) } : {}), ...(entry.body.from !== undefined ? { from: senderInput(entry.body.from) } : {}) };
    if (!mayAnswer(input, by, conf.config.humanInput?.approvers as string[] | undefined)) throw new HttpError(403, 'This person may not answer this input');
    if (input.state === 'pending' && input.expiresAt <= Date.now()) throw new HttpError(409, 'This input expired');
    checked.push({ input, answer: { ...answerInput(input, entry.body), by, at: Date.now() } });
  }
  const settled = checked.every(c => c.input.state === 'pending') ? await store.settleAll(checked.map(c => ({ id: c.input.id, answer: c.answer }))) : undefined;
  const rows = settled ?? await Promise.all(checked.map(c => store.get(c.input.id))) as InputRow[];
  if (!settled && !rows.every((row, i) => row.answer && !row.answer.by.system && row.answer.action === checked[i].answer.action && canonical(row.answer.content ?? null) === canonical(checked[i].answer.content ?? null))) throw new HttpError(409, 'An input is already settled');
  await agent.ctx.storage.put("decision-input-deadline", Date.now() + 5000);
  await agent.arm();
  const requests = await deliverDecisions(agent, rows, true);
  return { status: settled ? 202 : 200, inputs: rows.map(row => ({ ...inputView(row), question: row.message })), requests };
}
export async function expireDecisions(agent: AgentRuntime) {
  const store = decisionInputs(agent), conf = await agent.config(), expired = [];
  for (const row of await store.pending(conf.id)) if (row.blocking === false && row.expiresAt <= Date.now()) {
    const done = await store.settle(row.id, expiryAnswer(row), 'expired');
    if (done) expired.push(done);
  }
  const deliveries = await store.deliveries(conf.id);
  if (deliveries.size) await deliverDecisions(agent, [...deliveries.values()].flat());
  const pending = (await store.pending(conf.id)).filter(row => row.blocking === false);
  if (pending.length) await agent.ctx.storage.put("decision-input-deadline", Math.min(...pending.map(row => row.expiresAt)));
  else await agent.ctx.storage.delete("decision-input-deadline");
}
