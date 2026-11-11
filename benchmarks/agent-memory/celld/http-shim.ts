/** node:http / node:https for celld (benchmarks only): celld does not implement them. agent-base and https-proxy-agent
 * (pulled in by a model SDK's proxy support) subclass `Agent` when loaded; nothing in the benchmark makes a request. */
const missing = (name: string) => () => { throw new Error(`node:http ${name} is not available on celld`); };
export class Agent { constructor(_options?: unknown) {} destroy() {} }
export const globalAgent = new Agent();
export const request = missing("request");
export const get = missing("get");
export const createServer = missing("createServer");
export const STATUS_CODES: Record<number, string> = {};
export const METHODS: string[] = [];
export default { Agent, globalAgent, request, get, createServer, STATUS_CODES, METHODS };
