// Trusted source, evaluated only inside QuickJS. Captured host capabilities
// accept/return strings; their JS wrappers and prototypes belong to the guest.
// It runs once per sandbox image, before the snapshot that every execution starts
// from (quickjs-sandbox.ts), and returns what the host calls per execution:
// `install`, which defines `tools` from that execution's tool names, and the error formatter.

/** Calls answered by the host rather than a tool: no tool name contains a dot. */
export const HOST_CALLS = Object.freeze({ search: "tools.search", describe: "tools.describe", namespaces: "tools.namespaces" });

export const SANDBOX_BOOTSTRAP = `
(function(call, emit) {
  "use strict";
  // No shared-memory or blocking synchronization primitives are needed for
  // tool orchestration. These are optional QuickJS built-ins, not host APIs.
  delete globalThis.SharedArrayBuffer;
  delete globalThis.Atomics;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const StringCtor = String;
  const slice = Function.prototype.call.bind(String.prototype.slice);
  const text = value => {
    const rendered = typeof value === "string" ? value : (stringify(value) ?? StringCtor(value));
    emit(slice(rendered, 0, 128000), rendered.length > 128000 ? 1 : 0);
  };
  const console = Object.freeze(Object.fromEntries(
    ["log", "info", "warn", "error", "debug"].map(name => [name, (...values) => { for (const value of values) text(value); }])
  ));
  Object.defineProperties(globalThis, { text: { value: text }, console: { value: console } });
  // Only names: search, schemas and the calls themselves are answered by the host.
  const install = namesJSON => {
    const tools = Object.create(null);
    for (const name of parse(namesJSON)) {
      tools[name] = async (args = {}) => parse(await call(name, stringify(args)));
    }
    tools.search = async (query = "") => parse(await call("${HOST_CALLS.search}", stringify(query)));
    tools.describe = async name => parse(await call("${HOST_CALLS.describe}", stringify(StringCtor(name))));
    tools.namespaces = async () => parse(await call("${HOST_CALLS.namespaces}", "null"));
    Object.defineProperty(globalThis, "tools", { value: Object.freeze(tools) });
  };
  const formatError = error => {
    try { return slice(StringCtor(error && error.message || error), 0, 2048); }
    catch { return "Sandbox execution failed"; }
  };
  return [install, formatError];
})
`;
