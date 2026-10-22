import { createHash } from "node:crypto";
import { errorText } from "../protocol.ts";
import { canonical } from "../../shared/durable-json.ts";
import { type ClientEvent, type RequestRecord } from "../../shared/client-protocol.ts";
import { HttpError } from "../http.ts";
import { type McpResult } from "../mcp-results.ts";
import { actorInput } from "../identity.ts";
import { senderInput } from "../sender.ts";
import { type ToolCall } from "../tool-servers.ts";
import { answerInput, argumentsHash, expiresAt, INPUT_LIMITS, inputRequests, inputView, mayAnswer, type Answer, type Input, type InputRow, type Responder } from "../inputs.ts";
import { type Session, type ClientSessionOptions } from "./state.ts";

export type InputContext = {
  options: ClientSessionOptions;
  sessions: Map<string, Session>;
  publish(session: Session, data: ClientEvent): void;
  accept(session: Session, body: any, trusted?: boolean): Promise<{ record: RequestRecord }>;
  headerFor(id: string, tenant: string): Promise<Pick<Session, "header">>;
  submit(agent: string, tenant: string, body: { id: string; method: string; params: Record<string, unknown> }): Promise<RequestRecord>;
};

/** The id of the run that resumes a suspension: one per suspension, so every path that resumes it makes the same request. */
export const resumeId = (suspension: string) => `resume_${createHash("sha256").update(suspension).digest("hex").slice(0, 40)}`;

/** A batch of answers from a request: `{ answers: [{ id, action, content?, from?, actor? }] }`. */
export const answerList = (body: any) => {
  // Each answer an object, and its id not one: a null in the list, or an id like {"toString": null}, is the caller's
  // mistake (400), not a TypeError (500).
  const valid = (answer: any) => !!answer && typeof answer === "object" && !Array.isArray(answer) && (answer.id === null || typeof answer.id !== "object");
  if (!Array.isArray(body?.answers) || !body.answers.every(valid)) throw new HttpError(400, "Send { answers: [{ id, action, content?, from?, actor? }] }");
  return body.answers.map(({ id, ...answer }: any) => ({ id: String(id), body: answer }));
};

/**
 * Whether the agent has someone to ask: a channel's conversation, a definition that set up human
 * input (humanInput, ask_user), or an application connected to its stream. Only then may its
 * tools' servers ask for input (MCP's elicitation capability).
 */
export function humanSurface(session: Session) {
  const sources = session.header.sources;
  return !!(sources?.humanInput || sources?.builtins?.includes("ask_user") || session.channel || session.attached?.open);
}

/** Who approved a call, as tools are told: ids only, never names a person chose. */
export function approver(by: Responder) {
  return { ...(by.via ? { via: by.via } : {}), ...(by.from ? { from: by.from.id } : {}), ...(by.actor ? { actor: by.actor } : {}) };
}

/**
 * Suspend a tool call on the input its tool asked for: each request becomes an input (approvals
 * shown as the runtime sees the call, never as the model or tool describes it), announced on the
 * agent's stream, and the call returns open for the agent to leave waiting. Code in js_exec cannot
 * wait for days, so a call from there fails, pointing the model at a direct call.
 */
export async function suspend(ctx: InputContext, session: Session, call: ToolCall, request: RequestRecord | undefined, result: McpResult) {
  const inputs = ctx.options.inputs;
  let requests = inputRequests(result);
  const approval = requests.every(entry => entry.kind === "approval");
  if (!call.toolCallId || call.innerCallId || !request || !inputs) throw new Error(`${call.name} needs the user's ${approval ? "approval" : "input"}: call ${call.name} directly, not from js_exec`);
  const header = session.header;
  const hashed = argumentsHash(call.name, call.args);
  const shown = JSON.stringify(call.args);
  requests = requests.map(entry => entry.kind !== "approval" ? entry : {
    ...entry, message: `Allow ${call.name} to run?`,
    // The call's arguments as it has them; past INPUT_LIMITS.arguments of JSON, the start of that JSON instead.
    detail: { ...entry.detail, tool: call.name, source: call.name.includes("__") ? call.name.split("__")[0] : header.definitions.some(tool => tool.name === call.name) ? "application" : "runtime",
      ...shown.length > INPUT_LIMITS.arguments ? { argumentsPreview: `${shown.slice(0, INPUT_LIMITS.arguments)}…` } : { arguments: call.args }, argumentsHash: hashed },
  });
  const rows = await inputs.create({
    agent: header.id, tenant: header.tenant, requestId: request.id, toolCallId: call.toolCallId,
    responders: request.actor ? { audience: [request.actor] } : {}, expiresAt: expiresAt(header.sources?.humanInput, header.expiresAt),
    tool: call.name, argumentsHash: hashed, ...(typeof result.requestState === "string" ? { requestState: result.requestState } : {}),
  }, requests, session.claim);
  for (const row of rows) ctx.publish(session, { type: "event", requestId: request.id, event: { type: "input_required", input: inputView(row) } });
  return { content: [{ type: "text", text: "Waiting for the user's input." }], inputRequired: true };
}

/**
 * Settle every input the agent waits on, as the runtime: a new message supersedes them (the agent
 * closes their calls itself when it takes the message), and an abort cancels them, closing the
 * turn with a `resume` run that does not call the model.
 */
export async function cancelInputs(ctx: InputContext, session: Session, reason: "aborted" | "superseded") {
  const inputs = ctx.options.inputs;
  if (!inputs) return;
  const settled: InputRow[] = [];
  for (const input of await inputs.pending(session.header.id)) {
    const done = await inputs.settle(input.id, { action: "cancel", by: { system: reason }, at: Date.now() }, reason === "aborted" ? "cancelled" : "superseded");
    if (done) settled.push(done);
  }
  for (const input of settled) resolved(ctx, session, input);
  if (reason === "aborted") for (const suspension of new Set(settled.map(input => input.requestId))) await resumeSettled(ctx, session, suspension);
}

export function resolved(ctx: InputContext, session: Session, input: InputRow) {
  ctx.publish(session, { type: "event", requestId: input.requestId, event: { type: "input_resolved", id: input.id, state: input.state, by: input.answer?.by } });
}

/** Queue the run that resumes a suspension once none of its inputs is pending; idempotent per suspension. Returns its record, if any. */
async function resumeSettled(ctx: InputContext, session: Session, suspension: string): Promise<RequestRecord | undefined> {
  const rows = await ctx.options.inputs!.forRequest(session.header.id, suspension);
  if (!rows.length || rows.some(row => row.state === "pending")) return undefined;
  return (await ctx.accept(session, { id: resumeId(suspension), method: "resume", params: { suspension } }, true)).record;
}

/** A tenant's agent's inputs (`state`: pending, say), newest first. */
export async function inputsFor(ctx: InputContext, id: string, tenant: string, state?: string) {
  if (!ctx.options.inputs) return [];
  return (await ctx.options.inputs.list(tenant, { agent: id, ...(state ? { state } : {}) })).map(inputView);
}

/**
 * Answer a tenant's agent's inputs, all of them or none, on any node. An input settles once: the
 * same answer again is 200, a different one 409. Whoever a request names (`from`, `actor`) must be
 * among those who may answer (403). The last answer of a suspension queues its `resume` run on the
 * node serving the agent, returned in `requests`.
 */
export async function answer(ctx: InputContext, id: string, tenant: string, answers: { id: string; body: any }[], via: Responder["via"] = "api"): Promise<{ status: 200 | 202; inputs: Input[]; requests: RequestRecord[] }> {
  const inputs = ctx.options.inputs;
  if (!inputs) throw new HttpError(404, "Unknown agent");
  const { header } = await ctx.headerFor(id, tenant);
  if (!answers.length || answers.length > 100 || new Set(answers.map(entry => entry.id)).size !== answers.length) throw new HttpError(400, "Answer 1 to 100 different inputs");
  const checked: { input: InputRow; answer: Answer }[] = [];
  for (const { id: inputId, body } of answers) {
    const input = await inputs.get(inputId);
    if (!input || input.agent !== id) throw new HttpError(404, `Unknown input ${inputId}`);
    let by: Responder;
    try { by = { via, ...(body?.from !== undefined ? { from: senderInput(body.from) } : {}), ...(body?.actor !== undefined ? { actor: actorInput(body.actor) } : {}) }; }
    catch (error) { throw new HttpError(400, errorText(error)); }
    if (!mayAnswer(input, by, header.sources?.humanInput?.approvers)) throw new HttpError(403, "This person may not answer this input");
    checked.push({ input, answer: { ...answerInput(input, body), by, at: Date.now() } });
  }
  const settled = checked.every(({ input }) => input.state === "pending") ? await inputs.settleAll(checked.map(({ input, answer }) => ({ id: input.id, answer }))) : undefined;
  const suspensions = [...new Set(checked.map(({ input }) => input.requestId))];
  if (!settled) {
    // Settled already: a retry of these answers is 200; anything else conflicts, showing what was recorded.
    const current = await Promise.all(checked.map(({ input }) => inputs.get(input.id))) as InputRow[];
    const same = current.every((row, index) => row.answer && !row.answer.by.system && row.answer.action === checked[index].answer.action && canonical(row.answer.content ?? null) === canonical(checked[index].answer.content ?? null));
    if (!same) throw Object.assign(new HttpError(409, current.length === 1 ? `This input is already ${current[0].state}` : "An input is already settled"), { input: current.length === 1 ? inputView(current[0]) : current.map(inputView) });
    return { status: 200, inputs: current.map(inputView), requests: await resumeAnywhere(ctx, id, tenant, suspensions) };
  }
  // Announced here when this node serves the agent; otherwise its resume run announces them.
  const local = ctx.sessions.get(id);
  if (local) for (const input of settled) resolved(ctx, local, input);
  return { status: 202, inputs: settled.map(inputView), requests: await resumeAnywhere(ctx, id, tenant, suspensions) };
}

/** Resume each of these suspensions none of whose inputs is pending, on the node serving the agent; idempotent per suspension. */
async function resumeAnywhere(ctx: InputContext, agent: string, tenant: string, suspensions: string[]) {
  const submit = ctx.options.submit ?? ((agent, tenant, request) => ctx.submit(agent, tenant, request));
  const requests: RequestRecord[] = [];
  for (const suspension of suspensions) {
    if ((await ctx.options.inputs!.forRequest(agent, suspension)).some(row => row.state === "pending")) continue;
    requests.push(await submit(agent, tenant, { id: resumeId(suspension), method: "resume", params: { suspension } }));
  }
  return requests;
}

/** A tenant's inputs across its agents, newest first: the inbox of what waits on someone. */
export async function inbox(ctx: InputContext, tenant: string, state?: string) {
  return ctx.options.inputs ? (await ctx.options.inputs.list(tenant, state ? { state } : {})).map(inputView) : [];
}

/**
 * Expire inputs past their time, on any node: each suspension whose last input expired is resumed
 * on the node serving its agent, which closes the turn (or, with `onExpire: "resume"`, asks the model).
 */
export async function expireInputs(ctx: InputContext, now = Date.now()) {
  const inputs = ctx.options.inputs;
  if (!inputs) return;
  for (let batch; (batch = await inputs.due(now)).length;) {
    const suspensions = new Map<string, InputRow>();
    for (const input of batch) {
      const expired = await inputs.settle(input.id, { action: "cancel", by: { system: "expired" }, at: Date.now() }, "expired");
      if (expired) suspensions.set(`${expired.agent} ${expired.requestId}`, expired);
    }
    for (const input of suspensions.values()) {
      await resumeAnywhere(ctx, input.agent, input.tenant, [input.requestId])
        .catch(error => console.error(JSON.stringify({ type: "input_expiry_failed", agent: input.agent, error: errorText(error) })));
    }
    if (batch.length < 100) break;
  }
}
