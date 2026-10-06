// Measures what camelRun adds to one small model call, against calling OpenRouter directly with the same model and
// prompt: time to first token and total time, non-streaming and streaming, `--samples` of each, interleaved so drift
// at the provider hits both alike. Plain JavaScript on fetch alone, so it runs anywhere, the runtime's own image
// included (its region is the fair place to run it: the runtime's call to OpenRouter starts there).
//
//   node scripts/bench-overhead.mjs [--model openrouter/openai/gpt-4.1-nano] [--samples 20] [--url https://run.camelai.com]
//
// Keys, held in memory and never printed: OpenRouter's from OPENROUTER_API_KEY or the platform key in the tenants secret
// (camelai/agent-runtime/tenants), camelRun's from CAMELAI_API_KEY or the Secrets Manager secret --token-secret.
//
// The server-side split comes from the runtime's own timestamps (one clock): queued (the request's startedAt → began),
// before the model (began → the assistant message's timestamp, which Pi sets as it sends the model request: agent wake,
// history, hooks, billing and limit checks) and the model call to the run's end. The client's time less the server's is
// the network to the runtime and its API.
const args = process.argv.slice(2);
const flag = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback; };
const model = flag("model", "openrouter/openai/gpt-4.1-nano");
const samples = Number(flag("samples", "20"));
const url = flag("url", "https://run.camelai.com").replace(/\/+$/, "");
const SYSTEM = "You are a concise assistant.";
const PROMPT = "Reply with one short sentence about the sea.";

async function secret(id) {
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  return (await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: id }))).SecretString ?? "";
}
const openRouterKey = process.env.OPENROUTER_API_KEY ?? JSON.parse(await secret("camelai/agent-runtime/tenants")).platformKeys.openrouter;
const runtimeKey = process.env.CAMELAI_API_KEY ?? await secret(flag("token-secret", "camelai/agent-runtime/operator-token/miguel"));

/** Server-sent events from a fetch body: calls `frame(data)` with each frame's parsed data. */
async function readEvents(body, frame) {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of body) {
    const frames = (pending + decoder.decode(chunk, { stream: true })).split("\n\n");
    pending = frames.pop();
    for (const text of frames) {
      const data = text.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
      if (data && data !== "[DONE]") { try { if (frame(JSON.parse(data)) === false) return; } catch { /* not JSON */ } }
    }
  }
}

/** OpenRouter's Responses API, as the runtime calls it for this model; `pad` adds instructions to match the runtime's input size. */
async function direct(stream, pad = "") {
  const start = performance.now();
  const response = await fetch("https://openrouter.ai/api/v1/responses", {
    method: "POST", headers: { Authorization: `Bearer ${openRouterKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: model.replace(/^openrouter\//, ""), instructions: SYSTEM + pad, input: [{ role: "user", content: PROMPT }], stream, store: false }),
  });
  if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${(await response.text()).slice(0, 200)}`);
  if (!stream) { await response.json(); const total = performance.now() - start; return { ttftMs: total, totalMs: total }; }
  let ttft, last;
  await readEvents(response.body, data => {
    if (data.type !== "response.output_text.delta") return;
    last = performance.now() - start;
    ttft ??= last;
  });
  const total = performance.now() - start;
  return { ttftMs: ttft ?? NaN, totalMs: total, tailMs: last === undefined ? undefined : total - last };
}

async function api(path, init = {}) {
  const response = await fetch(`${url}${path}`, {
    method: init.method ?? "GET", headers: { Authorization: `Bearer ${runtimeKey}`, "Content-Type": "application/json", ...init.headers },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

/** The runtime's own timestamps for a run: its request record and the model call's assistant message. */
async function serverSplit(agentId, requestId, clientMs) {
  const record = await api(`/v1/agents/${agentId}/requests/${requestId}`);
  const messages = (await api(`/v1/agents/${agentId}/history?limit=4`)).entries.map(entry => entry.message);
  const user = messages.findIndex(message => message.role === "user" && message.requestId === requestId);
  const assistant = user >= 0 ? messages.slice(user + 1).find(message => message.role === "assistant") : undefined;
  if (!record.startedAt || !record.endedAt || !assistant) return undefined;
  const began = record.began ?? record.startedAt;
  const serverMs = record.endedAt - record.startedAt;
  return {
    queuedMs: began - record.startedAt, beforeModelMs: assistant.timestamp - began, modelToEndMs: record.endedAt - assistant.timestamp,
    serverMs, networkMs: clientMs - serverMs, inputTokens: assistant.usage ? assistant.usage.input + (assistant.usage.cacheRead ?? 0) : undefined,
  };
}

/** A run over REST, as a caller without an SDK makes one: prompt, then wait for its outcome. */
async function runtimeRest(agentId) {
  const start = performance.now();
  const { id } = await api(`/v1/agents/${agentId}/prompt`, { method: "POST", body: { text: PROMPT } });
  let record;
  do record = await api(`/v1/agents/${agentId}/requests/${id}?wait=25`); while (record.state !== "completed");
  const total = performance.now() - start;
  return { ttftMs: total, totalMs: total, server: await serverSplit(agentId, id, total) };
}

/** A streamed run: the agent's event stream (as a watcher) is open first, then the prompt; the first reply text, then its response. */
async function runtimeStream(agentId) {
  const controller = new AbortController();
  const events = await fetch(`${url}/v1/agents/${agentId}/events?watch=1&snapshot=0`, { headers: { Authorization: `Bearer ${runtimeKey}` }, signal: controller.signal });
  if (!events.ok) throw new Error(`events: ${events.status}`);
  // The stream replays what it has buffered (earlier runs' events), so frames count only once they name this run.
  let start, id, finished;
  const seen = [];
  let ready;
  const opened = new Promise(resolve => { ready = resolve; });
  const ended = () => id !== undefined && seen.some(({ data }) => data.type === "response" && data.id === id);
  const done = readEvents(events.body, data => {
    if (data.version !== undefined) ready();
    if (start === undefined) return;
    seen.push({ at: performance.now() - start, data });
    if (ended()) { finished = performance.now() - start; return false; }
  }).catch(() => {});
  await opened;
  start = performance.now();
  ({ id } = await api(`/v1/agents/${agentId}/prompt`, { method: "POST", body: { text: PROMPT } }));
  if (!ended()) await done;
  controller.abort();
  const total = finished ?? seen.find(({ data }) => data.type === "response" && data.id === id)?.at ?? performance.now() - start;
  const deltas = seen.filter(({ data }) => data.type === "event" && data.requestId === id && data.event?.type === "message_update" && data.event.assistantMessageEvent?.type === "text_delta");
  // tail: from the last reply text to the run's response, on one connection: what the runtime does after the model's
  // last token (the end of its stream, saving the turn, usage and billing), with no network in it.
  return { ttftMs: deltas[0]?.at ?? NaN, totalMs: total, tailMs: deltas.length ? total - deltas[deltas.length - 1].at : undefined, server: await serverSplit(agentId, id, total) };
}

const quantile = (values, q) => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]; };
function row(name, list) {
  const pick = get => list.map(get).filter(value => value !== undefined);
  const ms = values => values.length ? `${Math.round(quantile(values, 0.5))} / ${Math.round(quantile(values, 0.9))}` : "—";
  return `| ${name} | ${ms(pick(s => s.ttftMs))} | ${ms(pick(s => s.totalMs))} | ${ms(pick(s => s.server?.queuedMs))} | ${ms(pick(s => s.server?.beforeModelMs))} | ${ms(pick(s => s.server?.modelToEndMs))} | ${ms(pick(s => s.server?.networkMs))} |`;
}

const { id: agentId } = await api("/v1/agents", { method: "POST", headers: { "Idempotency-Key": `bench-overhead-${Date.now()}` }, body: { model, systemPrompt: SYSTEM, name: "bench-overhead" } });
try {
  const cold = await runtimeRest(agentId);
  const tokens = cold.server?.inputTokens ?? 0;
  // About 4 characters a token: the direct call padded to the runtime's input (its prompt, tool definitions, history).
  const pad = tokens > 40 ? `\n\n${"Background that does not matter here. ".repeat(Math.round((tokens - 30) * 4 / 38))}` : "";
  const results = { directNonStreaming: [], directStreaming: [], directStreamingPadded: [], runtimeRest: [], runtimeStreaming: [] };
  for (let index = 0; index < samples; index++) {
    results.directNonStreaming.push(await direct(false));
    results.directStreaming.push(await direct(true));
    results.directStreamingPadded.push(await direct(true, pad));
    results.runtimeRest.push(await runtimeRest(agentId));
    results.runtimeStreaming.push(await runtimeStream(agentId));
  }
  console.log(`model ${model}, ${samples} samples each, runtime ${url}, runtime input ~${tokens} tokens on its first run; ms as median / p90`);
  console.log(`cold first run over REST: total ${Math.round(cold.totalMs)} ms, server ${JSON.stringify(cold.server)}`);
  console.log("| path | first token | total | queued | before model | model → end | network + API |");
  console.log("|---|---|---|---|---|---|---|");
  console.log(row("OpenRouter direct, non-streaming", results.directNonStreaming));
  console.log(row("OpenRouter direct, streaming", results.directStreaming));
  console.log(row(`OpenRouter direct, streaming, padded to ~${tokens} tokens`, results.directStreamingPadded));
  console.log(row("camelRun REST (prompt, then wait)", results.runtimeRest));
  console.log(row("camelRun streamed (events, then prompt)", results.runtimeStreaming));
  if (flag("json")) console.log(JSON.stringify({ model, url, samples, cold, results }));
} finally {
  await api(`/v1/agents/${agentId}`, { method: "DELETE" }).catch(() => {});
}
