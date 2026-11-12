// The public workflow API (docs/design/swarm-workflows.md, "API and SDK"), Workers only, gated per tenant:
//   POST /v1/workflows                      { script, args?, budget: { usd: number | null }, concurrency?, classes?, name? } -> 201
//   GET  /v1/workflows/{id}                 status, counts (counts.cached: results reused from the owner's cache), spent
//   GET  /v1/workflows/{id}/items|events
//   POST /v1/workflows/{id}/pause|resume|abort|budget
// A workflow is not edited: to change one, abort it and start a new one (finished results are reused).
import { digest } from "./api-contract.ts";
import { AgentOptionsError, classesInput } from "./workflow-types.ts";
import type { WorkflowEnv, WorkflowSettings } from "./workflow-object.ts";
import { refusedOf, WorkflowError } from "./workflow-runner.ts";
import type { Owner } from "../../../shared/owner.ts";

/** Who has workflows: `AGENT_WORKFLOW_TENANTS`, a comma-separated list of tenant ids, or `*` for every tenant. */
export function workflowsEnabled(env: { AGENT_WORKFLOW_TENANTS?: string }, tenant: string) {
  const list = (env.AGENT_WORKFLOW_TENANTS ?? "").split(",").map(id => id.trim()).filter(Boolean);
  return list.includes("*") || list.includes(tenant);
}

export const WORKFLOWS_OFF = "Workflows are not enabled for this account yet. Ask us to turn them on.";
export const WORKFLOW_SCRIPT_CHARS = 256 * 1024;

export class WorkflowInputError extends Error {}

/** What a start may carry; refused with a WorkflowInputError naming the field. */
export function startInput(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new WorkflowInputError("Expected a JSON object");
  const { script, args, budget, concurrency, classes, name, allowFastJudgment, ...rest } = body as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length) throw new WorkflowInputError(`Unknown field ${unknown[0]}`);
  if (typeof script !== "string" || !script.trim() || script.length > WORKFLOW_SCRIPT_CHARS) throw new WorkflowInputError(`script is the workflow's JavaScript, 1 to ${WORKFLOW_SCRIPT_CHARS} characters`);
  if (!budget || typeof budget !== "object" || Array.isArray(budget) || !("usd" in budget)) throw new WorkflowInputError("budget is { usd }: the most the workflow may spend (USD), or null for no cap");
  const usd = (budget as { usd: unknown }).usd;
  if (usd !== null && (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0)) throw new WorkflowInputError("budget.usd is a positive number of USD, or null for no cap");
  if (concurrency !== undefined && (!Number.isInteger(concurrency) || (concurrency as number) < 1 || (concurrency as number) > 64)) throw new WorkflowInputError("concurrency is an integer from 1 to 64");
  if (name !== undefined && (typeof name !== "string" || !/^[A-Za-z0-9 _.:-]{1,100}$/.test(name))) throw new WorkflowInputError("name is 1 to 100 letters, digits, spaces and _ . : -");
  if (allowFastJudgment !== undefined && typeof allowFastJudgment !== "boolean") throw new WorkflowInputError("allowFastJudgment is true or false");
  if (args !== undefined && JSON.stringify(args).length > 64 * 1024) throw new WorkflowInputError("args is JSON of at most 64 KiB");
  let pinned;
  try { pinned = classesInput(classes); } catch (error) { if (error instanceof AgentOptionsError) throw new WorkflowInputError(error.message); throw error; }
  return {
    script, budgetUsd: usd as number | null, ...(concurrency !== undefined ? { concurrency: concurrency as number } : {}),
    settings: { ...(name !== undefined ? { name: name as string } : {}), ...(args !== undefined ? { args } : {}), ...(pinned ? { classes: pinned } : {}), ...(allowFastJudgment ? { allowFastJudgment: true } : {}) } satisfies WorkflowSettings,
  };
}

/** A new workflow's id; with an idempotency key, the same id for the same key of the same tenant. */
export async function workflowId(tenant: string, idempotencyKey?: string | null) {
  if (idempotencyKey) return `wf_${(await digest(`workflow:${tenant}:${idempotencyKey}`)).slice(0, 40)}`;
  return `wf_${[...crypto.getRandomValues(new Uint8Array(20))].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** The workflow object's RPC surface the API uses (workflow-object.ts). */
export interface WorkflowStub {
  get(): Promise<Record<string, unknown> & { tenant?: string }>;
  view(): Promise<Record<string, unknown>>;
  create(init: Record<string, unknown>, settings: WorkflowSettings): Promise<unknown>;
  items(query: Record<string, unknown>): Promise<unknown>;
  events(query: Record<string, unknown>): Promise<unknown>;
  pause(options: { children?: "abort" }): Promise<unknown>;
  resume(): Promise<unknown>;
  abort(): Promise<unknown>;
  setBudget(usd: number | null): Promise<unknown>;
}
type Stub = WorkflowStub;
const METHODS = ["get", "view", "create", "items", "events", "pause", "resume", "abort", "setBudget"] as const;
/**
 * The workflow `id`'s object, its refusals thrown again here as `WorkflowError`s: the object answers them as values
 * (refusable) so they are not logged as its uncaught errors.
 */
export function workflowStub(env: WorkflowEnv, id: string): WorkflowStub {
  const stub = (env.WORKFLOWS as unknown as { getByName(name: string): Record<string, (...args: unknown[]) => Promise<unknown>> }).getByName(id);
  return Object.fromEntries(METHODS.map(method => [method, async (...args: unknown[]) => refusedOf(await stub[method]!(...args))])) as unknown as WorkflowStub;
}
/** The workflow's summary, or undefined when there is none yet. */
const existing = (stub: WorkflowStub) => stub.get().catch(error => { if (error instanceof WorkflowError && error.status === 404) return undefined; throw error; });

/** Start a workflow for `tenant` (an account's start, or an agent's through the builtin, which then owns it). */
export async function startWorkflow(env: WorkflowEnv, tenant: string, input: ReturnType<typeof startInput>, options: { owner?: Owner; bucket?: string; idempotencyKey?: string | null; runtimeOrigin?: string; beforeCreate?(id: string): Promise<void> } = {}) {
  const id = await workflowId(tenant, options.idempotencyKey);
  const stub = workflowStub(env, id);
  const found = await existing(stub);
  if (found && found.tenant !== tenant) throw new WorkflowInputError("That idempotency key names another workflow");
  // The owner's row for it (workflow_start), written before the workflow exists, so no ending can come before it.
  await options.beforeCreate?.(id);
  await stub.create({ code: input.script, budgetUsd: input.budgetUsd, ...(input.concurrency ? { concurrency: input.concurrency } : {}), tenant, ...(options.bucket ? { bucket: options.bucket } : {}) },
    { ...input.settings, ...(options.owner ? { owner: options.owner } : {}), ...(options.runtimeOrigin ? { runtimeOrigin: options.runtimeOrigin } : {}) });
  return { id, ...(await stub.view()) };
}

/** The workflow `id` of `tenant`, or undefined: another tenant's workflow is not found, as an unknown one is. */
export async function ownWorkflow(env: WorkflowEnv, tenant: string, id: string): Promise<Stub | undefined> {
  if (!/^wf_[A-Za-z0-9_-]{1,80}$/.test(id)) return undefined;
  const stub = workflowStub(env, id);
  const summary = await existing(stub);
  return summary?.tenant === tenant ? stub : undefined;
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const refuse = (status: number, error: string, code: string) => json({ error, code }, status);

export async function workflowRoutes(request: Request, env: WorkflowEnv & { AGENT_WORKFLOW_TENANTS?: string }, tenant: string): Promise<Response | undefined> {
  const url = new URL(request.url);
  const match = /^\/v1\/workflows(?:\/([^/]+)(?:\/([a-z]+))?)?$/.exec(url.pathname);
  if (!match) return undefined;
  if (!workflowsEnabled(env, tenant)) return refuse(403, WORKFLOWS_OFF, "WORKFLOWS_OFF");
  const [, id, action] = match;
  const body = async () => { try { return await request.json(); } catch { throw new WorkflowInputError("Expected a JSON body"); } };
  try {
    if (!id) {
      if (request.method !== "POST") return refuse(405, "Start a workflow with POST /v1/workflows", "METHOD_NOT_ALLOWED");
      return json(await startWorkflow(env, tenant, startInput(await body()), { idempotencyKey: request.headers.get("Idempotency-Key"), runtimeOrigin: url.origin }), 201);
    }
    const stub = await ownWorkflow(env, tenant, decodeURIComponent(id));
    if (!stub) return refuse(404, "Unknown workflow", "NOT_FOUND");
    const query = url.searchParams, number = (name: string) => query.has(name) ? Number(query.get(name)) : undefined;
    const view = async () => ({ id, ...(await stub.view()) });
    if (request.method === "GET") {
      if (!action) return json(await view());
      if (action === "items") return json(await stub.items({ after: number("after"), limit: number("limit"), ...(query.get("status") ? { status: query.get("status")! } : {}), ...(query.get("kind") ? { kind: query.get("kind")! } : {}) }));
      if (action === "events") return json({ events: await stub.events({ after: number("after"), limit: number("limit") }) });
      return refuse(404, "Not found", "NOT_FOUND");
    }
    if (request.method !== "POST") return refuse(405, "Method not allowed", "METHOD_NOT_ALLOWED");
    const input = await request.text().then(text => text ? JSON.parse(text) as Record<string, unknown> : {}).catch(() => { throw new WorkflowInputError("Expected a JSON body"); });
    if (action === "pause") {
      if (input.children !== undefined && input.children !== "abort") throw new WorkflowInputError('children is "abort" (stop running children), or absent to let them finish');
      await stub.pause(input.children ? { children: "abort" } : {});
    } else if (action === "resume") {
      if (Object.keys(input).length) throw new WorkflowInputError(`Unknown field ${Object.keys(input)[0]}: resume takes no options (to change a workflow, abort it and start a new one)`);
      await stub.resume();
    } else if (action === "abort") await stub.abort();
    else if (action === "budget") {
      const usd = input.usd;
      if (usd !== null && (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0)) throw new WorkflowInputError("usd is a positive number of USD, or null for no cap");
      await stub.setBudget(usd as number | null);
    } else return refuse(404, "Not found", "NOT_FOUND");
    return json(await view());
  } catch (error) {
    if (error instanceof WorkflowInputError || error instanceof SyntaxError) return refuse(400, error.message, "INVALID_REQUEST");
    // The workflow's own refusals (an aborted workflow resumed, a confirm needed), answered by the object as values.
    return refuse(409, error instanceof Error ? error.message : String(error), "WORKFLOW_CONFLICT");
  }
}
