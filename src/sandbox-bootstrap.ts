// Trusted source, evaluated only inside QuickJS. Captured host capabilities
// accept/return strings; their JS wrappers and prototypes belong to the guest.
// It runs once per sandbox image, before the snapshot that every execution starts
// from (quickjs-sandbox.ts), and returns what the host calls per execution:
// `install`, which defines `tools` from that execution's catalog, and the error formatter.
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
  const install = catalogJSON => {
    const catalog = parse(catalogJSON);
    const tools = Object.create(null);
    for (const definition of catalog) {
      tools[definition.name] = async (args = {}) => parse(await call(definition.name, stringify(args)));
    }
    tools.search = async (query = "") => parse(stringify(catalog.filter(d =>
      (d.name + " " + d.description).toLowerCase().includes(StringCtor(query).toLowerCase()))));
    tools.describe = async name => parse(stringify(catalog.find(d => d.name === name) ?? null));
    Object.defineProperty(globalThis, "tools", { value: Object.freeze(tools) });
  };
  const formatError = error => {
    try { return slice(StringCtor(error && error.message || error), 0, 2048); }
    catch { return "Sandbox execution failed"; }
  };
  return [install, formatError];
})
`;
