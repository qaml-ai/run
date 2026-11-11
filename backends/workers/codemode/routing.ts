import type { CodemodeRemote, CodemodeRemoteExchange, CodemodeRemoteMessage, CodemodeRemoteReply } from "@earendil-works/pi-codemode/portable";
import { checkExchange, EXCHANGE_PROTOCOL, isExchangeHello, needsHello, type ExchangeParameters, type ExchangeRequest, type ResultHandle } from "./exchange.ts";

/**
 * Keeps a result body on the host for a `handle` exchange and returns its reference (a volume path, a journal key):
 * the guest gets `{ $handle: <reference>, bytes, sha256 }` instead of the body.
 */
export type KeepResult = (body: string, call: { id: number; name: string }) => Promise<unknown> | unknown;

/**
 * The host's side of one execution's exchange: `exchange` (Pi's) behind the parameters it is opened with. It drops
 * the sandbox's hello, refuses a sandbox that did not send one when these parameters need it (see `needsHello`), and
 * in `handle` mode keeps any result body over `caps.resultBytes` on the host through `keep`.
 */
export function hostExchange(parameters: ExchangeParameters, exchange: CodemodeRemoteExchange, keep?: KeepResult) {
  const required = needsHello(parameters);
  let heard: boolean | undefined, refused: string | undefined;
  const handled = async (reply: CodemodeRemoteReply, messages: CodemodeRemoteMessage[]): Promise<CodemodeRemoteReply> => {
    if (reply?.type !== "result" || !reply.ok || reply.payload === undefined) return reply;
    const body = new TextEncoder().encode(reply.payload);
    if (body.byteLength <= parameters.caps.resultBytes) return reply;
    const call = messages.find(message => message.type === "call");
    const ref = await keep!(reply.payload, { id: reply.id, name: call?.type === "call" ? call.name : "" });
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
    const handle: ResultHandle = { $handle: ref, bytes: body.byteLength, sha256: [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("") };
    return { ...reply, payload: JSON.stringify(handle) };
  };
  const wrapped: CodemodeRemoteExchange = async messages => {
    if (refused) return { type: "stop" };
    if (heard === undefined) {
      const first: unknown = messages[0];
      heard = isExchangeHello(first);
      const spoken = heard ? (first as { protocol?: unknown }).protocol : 1;
      if (spoken !== EXCHANGE_PROTOCOL && (heard || required))
        refused = `The sandbox speaks code mode exchange protocol ${String(spoken)}, not ${EXCHANGE_PROTOCOL}: the agent and sandbox Workers run different versions.`;
      if (refused) return { type: "stop" };
    }
    const vm = heard ? messages.filter(message => !isExchangeHello(message)) : messages;
    const reply = await exchange(vm);
    return parameters.results === "handle" ? handled(reply, vm) : reply;
  };
  return { exchange: wrapped, refused: () => refused };
}

/**
 * One sandbox DO per session; admission is held until the remote VM has stopped. Every execution's exchange is opened
 * with `exchange` (code mode's is `CODE_MODE_EXCHANGE`); a `handle` exchange needs `keep`.
 */
export function isolatedSandboxRemote(options: {
  agentKey: string;
  getByName: (key: string) => CodemodeRemote;
  exchange: ExchangeParameters;
  keep?: KeepResult;
  maxConcurrent?: number;
}): () => CodemodeRemote {
  const limit = options.maxConcurrent ?? 3;
  if (!Number.isInteger(limit) || limit < 1 || limit > 3)
    throw new Error("Invalid sandbox concurrency limit");
  const parameters = checkExchange(options.exchange);
  if (parameters.results === "handle" && !options.keep) throw new Error("A handle exchange needs keep");
  // This in-memory guard resets with its owner. It is not a durable quota on
  // remote work that may outlive a caller reset or its own wall-time deadline.
  let active = 0;
  return () => ({
    async execute(request, exchange) {
      // Refuse excess work rather than building an unbounded in-memory queue
      // outside Pi's journal. The stock bridge returns this as a sandbox error.
      if (active >= limit)
        throw new Error(`Agent sandbox concurrency limit (${limit}) reached`);
      active++;
      try {
        const most = parameters.caps.interruptBudget;
        const sent: ExchangeRequest = { ...request, interruptBudget: Math.min(request.interruptBudget ?? most, most), exchange: parameters };
        const host = hostExchange(parameters, exchange, options.keep);
        // The session's executions share one isolate. Each RPC still owns an
        // independent VM; the remote subclass also enforces this cap.
        await options.getByName(options.agentKey).execute(sent, host.exchange);
        // A sandbox that cannot serve this exchange was told to stop; the stock bridge reports this as
        // `Remote sandbox failed: ...`.
        const refused = host.refused();
        if (refused) throw new Error(refused);
        // A caller deadline is not proof that the remote stopped. Keep the slot
        // until RPC completion/rejection; otherwise timeouts admit more live VMs.
      } finally {
        active--;
      }
    },
  });
}
