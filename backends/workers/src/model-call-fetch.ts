// Generated from src/compaction.ts; source function/body unchanged.
import type { UsageSink } from "./model-attempt-stream.ts";
import { network } from "./account-network.ts";
export const FETCH_APIS = ["openai-completions", "openai-responses", "anthropic-messages"];
export function callFetch(sink: UsageSink, plan: { rebase?: { from: string[]; to: string }; keyless?: boolean; bearer?: string; base?: typeof fetch } = {}): typeof fetch {
  const read = async (line: string) => {
    if (!line.startsWith("data:") && !line.startsWith("{")) return;
    let data: any;
    try { data = JSON.parse(line.startsWith("data:") ? line.slice(5) : line); } catch { return; }
    {
      const generation = data?.id ?? data?.response?.id ?? data?.message?.id;
      if (typeof generation === "string") await sink.generation?.(generation);
      // The host OpenRouter routed the call to: its chunks' `provider`, or an error's `metadata.provider_name`.
      const host = data?.provider ?? data?.response?.provider ?? data?.error?.metadata?.provider_name;
      if (typeof host === "string" && /^[\w .()/-]{1,60}$/.test(host)) sink.host = host;
      const usage = data?.usage ?? data?.response?.usage ?? data?.message?.usage;
      // The service tier that served the call, as OpenRouter says it: top level (Chat Completions, Responses), or in
      // usage (Anthropic Messages, which calls the default tier "standard").
      const tier = data?.service_tier ?? data?.response?.service_tier ?? usage?.service_tier;
      if (typeof tier === "string" && /^[a-z_]{1,20}$/.test(tier)) sink.serviceTier = tier === "standard" ? "default" : tier;
      if (typeof usage?.cost !== "number" || !Number.isFinite(usage.cost) || usage.cost < 0) return;
      const upstream = usage.is_byok ? Number(usage.cost_details?.upstream_inference_cost) : 0;
      sink.credits = usage.cost;
      sink.cost = usage.cost + (Number.isFinite(upstream) && upstream > 0 ? upstream : 0);
    }
  };
  return async (input, init) => {
    let url = String(input);
    if (plan.rebase) {
      const from = plan.rebase.from.find(prefix => url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`));
      if (!from) throw new Error(`The key scope's baseUrl does not stand for ${new URL(url).origin}`);
      url = plan.rebase.to + url.slice(from.length);
    }
    let headers = init?.headers;
    if (plan.keyless) {
      const without = new Headers(headers);
      for (const name of ["authorization", "x-api-key"]) without.delete(name);
      headers = without;
    } else if (plan.bearer) {
      const bearer = new Headers(headers);
      bearer.delete("x-api-key");
      bearer.set("authorization", `Bearer ${plan.bearer}`);
      headers = bearer;
    }
    const response = await (plan.base ?? network().fetch)(url, { ...init, headers });
    // Messages API bodies carry Anthropic msg_* IDs; OpenRouter's lookup ID is in this header.
    // Persist it before exposing any response bytes, including empty/error responses.
    const generation = response.headers.get("x-generation-id");
    if (generation) {
      try { await sink.generation?.(generation); }
      catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    }
    if (!response.body) return response;
    const decoder = new TextDecoder();
    let pending = "";
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        const lines = (pending + decoder.decode(chunk, { stream: true })).split("\n");
        pending = lines.pop()!;
        for (const line of lines) await read(line.trim());
        controller.enqueue(chunk);
      },
      async flush() { await read(pending.trim()); },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
