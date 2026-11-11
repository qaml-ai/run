import type { CodemodeRemoteMessage, CodemodeRemoteRequest } from "@earendil-works/pi-codemode/portable";
import { SANDBOX_LIMITS } from "../../../src/limits.ts";

/**
 * The exchange between an agent Worker (the host: tools, records, deadlines) and the sandbox Worker (the VM). The two
 * deploy separately and, mid-rollout, either may be a version ahead, so every request names the protocol it speaks.
 *
 * - 1: no `exchange` in the request. Code mode's caps and inline results, fixed in the sandbox. Only an agent Worker
 *   from before protocol 2 sends it; the sandbox still serves it until no such Worker runs (remove it then).
 * - 2: the request carries `exchange: ExchangeParameters`. The sandbox enforces its caps and opens its first message
 *   batch with `{ type: "exchange", protocol: 2 }`, so the host can tell it was understood.
 */
export const EXCHANGE_PROTOCOL = 2;

/** What one execution may do through its exchange. The sandbox enforces every field. */
export interface ExchangeCaps {
  /** Calls the script makes in all, replayed ones included. */
  calls: number;
  /** Calls out at once; past it a call waits its turn (as v8-exec queues it in the guest). */
  inFlight: number;
  /** One call's arguments, as JSON. */
  argumentBytes: number;
  /** One result, as JSON, that crosses into the guest. In `handle` mode a larger body stays on the host instead. */
  resultBytes: number;
  /** Every result that crosses into the guest, in all. */
  totalResultBytes: number;
  /** QuickJS interrupt polls for the VM's whole life (its replay too): Workers clocks freeze in synchronous code. */
  interruptBudget: number;
}

export interface ExchangeParameters {
  protocol: typeof EXCHANGE_PROTOCOL;
  caps: ExchangeCaps;
  /**
   * `inline`: every result body crosses into the guest, and one over `caps.resultBytes` fails the call.
   * `handle`: a body over `caps.resultBytes` stays on the host; the guest gets `ResultHandle` JSON instead.
   */
  results: "inline" | "handle";
}

/** What the guest gets for a body kept on the host: the caller's reference to it (a volume path, a journal key), its size and digest. */
export interface ResultHandle { $handle: unknown; bytes: number; sha256: string }

/** One poll is QuickJS's own interrupt check; keep non-yielding scripts below the isolate's CPU reset. Not a clock. */
export const SANDBOX_INTERRUPT_BUDGET = 10_000;

/** One VM's QuickJS heap: three of them leave headroom for Wasm and the host in a 128 MiB isolate. */
export const SANDBOX_HEAP_BYTES = 24 * 1024 * 1024;

/** Code mode's exchange: exactly the caps the sandbox fixed before they became parameters. */
export const CODE_MODE_EXCHANGE: ExchangeParameters = Object.freeze({
  protocol: EXCHANGE_PROTOCOL,
  caps: Object.freeze({
    calls: SANDBOX_LIMITS.toolCalls,
    inFlight: SANDBOX_LIMITS.concurrentTools,
    argumentBytes: SANDBOX_LIMITS.argumentBytes,
    resultBytes: SANDBOX_LIMITS.resultBytes - 1024,
    totalResultBytes: SANDBOX_LIMITS.totalToolBytes,
    interruptBudget: SANDBOX_INTERRUPT_BUDGET,
  }),
  results: "inline",
});

/**
 * The most any caller may ask for, whatever it is. The sandbox isolate holds three 24 MiB heaps; the poll budget stays
 * at what keeps a non-yielding script under the isolate's CPU limit. Calls and in-flight are host-side costs, sized for
 * a workflow step (10,000 journaled effects, 64 children at once).
 */
export const EXCHANGE_CEILINGS: ExchangeCaps = Object.freeze({
  calls: 10_000,
  inFlight: 64,
  argumentBytes: SANDBOX_LIMITS.argumentBytes,
  resultBytes: SANDBOX_LIMITS.resultBytes - 1024,
  totalResultBytes: SANDBOX_LIMITS.totalToolBytes,
  interruptBudget: SANDBOX_INTERRUPT_BUDGET,
});

/** A request as the agent Worker sends it from protocol 2 on. */
export type ExchangeRequest = CodemodeRemoteRequest & { exchange?: ExchangeParameters };

/** The sandbox's first message on a protocol 2 exchange. */
export type ExchangeHello = { type: "exchange"; protocol: typeof EXCHANGE_PROTOCOL };
export const isExchangeHello = (message: unknown): message is ExchangeHello =>
  typeof message === "object" && message !== null && (message as { type?: unknown }).type === "exchange";
/** What the sandbox may send on a protocol 2 exchange. */
export type ExchangeMessage = CodemodeRemoteMessage | ExchangeHello;

/** Throws, naming the field, unless `parameters` are a protocol 2 exchange within the ceilings. */
export function checkExchange(parameters: ExchangeParameters): ExchangeParameters {
  const where = "Code mode exchange";
  if (typeof parameters !== "object" || parameters === null) throw new Error(`${where}: parameters missing`);
  if (parameters.protocol !== EXCHANGE_PROTOCOL)
    throw new Error(`${where}: protocol ${String(parameters.protocol)} is not ${EXCHANGE_PROTOCOL}, the one this sandbox speaks; the agent and sandbox Workers run different versions`);
  if (parameters.results !== "inline" && parameters.results !== "handle")
    throw new Error(`${where}: results must be "inline" or "handle", not ${JSON.stringify(parameters.results)}`);
  const caps = parameters.caps;
  if (typeof caps !== "object" || caps === null) throw new Error(`${where}: caps missing`);
  for (const name of Object.keys(EXCHANGE_CEILINGS) as (keyof ExchangeCaps)[]) {
    const value = caps[name], most = EXCHANGE_CEILINGS[name];
    if (!Number.isSafeInteger(value) || value < 1 || value > most)
      throw new Error(`${where}: caps.${name} must be an integer from 1 to ${most}, not ${JSON.stringify(value)}`);
  }
  return parameters;
}

/**
 * The sandbox side: the parameters a request was made with. Protocol 1 (no `exchange`) is code mode's; anything else
 * is checked, and one this sandbox cannot serve throws, which the host reports as `Remote sandbox failed: ...`.
 */
export function requestExchange(request: ExchangeRequest): { parameters: ExchangeParameters; hello: boolean } {
  if (request.exchange === undefined) return { parameters: CODE_MODE_EXCHANGE, hello: false };
  return { parameters: checkExchange(request.exchange), hello: true };
}

/**
 * Whether a host must hear the sandbox's hello before it trusts the exchange. A protocol 1 sandbox serves code mode's
 * caps and inline results whatever it is asked, so code mode may run on one mid-rollout; any other exchange may not.
 */
export function needsHello(parameters: ExchangeParameters) {
  if (parameters.results !== "inline") return true;
  return (Object.keys(EXCHANGE_CEILINGS) as (keyof ExchangeCaps)[]).some(name => parameters.caps[name] !== CODE_MODE_EXCHANGE.caps[name]);
}
