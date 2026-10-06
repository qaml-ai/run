// Trusted source, evaluated only inside the guest's V8 context (v8-exec compiles it in:
// scripts/gen-v8-bootstrap.ts). Captured host capabilities
// accept/return strings; their JS wrappers and prototypes belong to the guest.
// It runs before guest code, and returns what the host calls per execution:
// `install`, which defines `tools` from that execution's tool names, the error formatter, and
// `finish`, which sends what the code returned.

/** Calls answered by the host rather than a tool: no tool name contains a dot. */
export const HOST_CALLS = Object.freeze({ search: "tools.search", describe: "tools.describe", namespaces: "tools.namespaces" });
/** The `fs` calls: the runtime's file tools over the agent's mounts, whoever else has tools of those names. */
export const FS_CALLS = Object.freeze(["fs.readFile", "fs.writeFile", "fs.stat", "fs.list", "fs.remove"]);

export const SANDBOX_BOOTSTRAP = `
(function(call, emit) {
  "use strict";
  // No shared-memory or blocking synchronization primitives are needed for
  // tool orchestration. These are ECMAScript built-ins, not host APIs.
  delete globalThis.SharedArrayBuffer;
  delete globalThis.Atomics;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const StringCtor = String;
  const slice = Function.prototype.call.bind(String.prototype.slice);
  // emit's flags: 1, cut at 128,000 characters; 2, the value code returned; 4, rendered as JSON.
  const send = (rendered, flags) => emit(slice(rendered, 0, 128000), flags | (rendered.length > 128000 ? 1 : 0));
  const text = value => send(typeof value === "string" ? value : (stringify(value) ?? StringCtor(value)), 0);
  const console = Object.freeze(Object.fromEntries(
    ["log", "info", "warn", "error", "debug"].map(name => [name, (...values) => { for (const value of values) text(value); }])
  ));
  // Bytes cross as base64 in the JSON string the bridge carries, and are Uint8Arrays on this side.
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const CODES = new Uint8Array(128);
  for (let i = 0; i < 64; i++) CODES[ALPHABET.charCodeAt(i)] = i;
  const toBase64 = bytes => {
    const parts = [];
    for (let start = 0; start < bytes.length; start += 3072) {
      const end = Math.min(start + 3072, bytes.length), chunk = [];
      for (let i = start; i < end; i += 3) {
        const n = bytes[i] << 16 | (i + 1 < end ? bytes[i + 1] << 8 : 0) | (i + 2 < end ? bytes[i + 2] : 0);
        chunk.push(ALPHABET[n >> 18 & 63], ALPHABET[n >> 12 & 63], i + 1 < end ? ALPHABET[n >> 6 & 63] : "=", i + 2 < end ? ALPHABET[n & 63] : "=");
      }
      parts.push(chunk.join(""));
    }
    return parts.join("");
  };
  const fromBase64 = base64 => {
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    const bytes = new Uint8Array(base64.length / 4 * 3 - padding);
    for (let i = 0, o = 0; i < base64.length; i += 4) {
      const n = CODES[base64.charCodeAt(i)] << 18 | CODES[base64.charCodeAt(i + 1)] << 12 | CODES[base64.charCodeAt(i + 2)] << 6 | CODES[base64.charCodeAt(i + 3)];
      bytes[o++] = n >> 16 & 255;
      if (o < bytes.length) bytes[o++] = n >> 8 & 255;
      if (o < bytes.length) bytes[o++] = n & 255;
    }
    return bytes;
  };
  const fsCall = async (name, args) => parse(await call("fs." + name, stringify(args)));
  const fs = Object.freeze({
    readFile: async (path, options) => {
      // Node's two forms: readFile(path, "utf8") and readFile(path, { encoding: "utf8" }).
      const encoding = typeof options === "string" ? options : options && options.encoding;
      const read = await fsCall("readFile", encoding ? { path, encoding } : { path });
      return typeof read.text === "string" ? read.text : fromBase64(read.data);
    },
    writeFile: async (path, data, options) => {
      const contentType = options && options.contentType;
      const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : undefined;
      if (typeof data !== "string" && !bytes) throw new TypeError("fs.writeFile takes a string or a Uint8Array");
      const body = typeof data === "string" ? { text: data } : { data: toBase64(bytes) };
      return fsCall("writeFile", contentType ? { path, ...body, contentType } : { path, ...body });
    },
    stat: path => fsCall("stat", { path }),
    list: path => fsCall("list", { path }),
    remove: path => fsCall("remove", { path }),
  });
  Object.defineProperties(globalThis, { text: { value: text }, console: { value: console }, fs: { value: fs } });
  // Only names: search, schemas and the calls themselves are answered by the host.
  const install = namesJSON => {
    const tools = Object.create(null);
    for (const name of parse(namesJSON)) {
      tools[name] = async (args = {}) => parse(await call(name, stringify(args)));
    }
    // search(query), search(query, { namespace, limit }), search(query, namespace) or search({ query, namespace, limit }).
    tools.search = async (query = "", options) => parse(await call("${HOST_CALLS.search}", stringify(options === undefined ? query : { ...(typeof options === "string" ? { namespace: options } : options), query })));
    tools.describe = async name => parse(await call("${HOST_CALLS.describe}", stringify(StringCtor(name))));
    tools.namespaces = async () => parse(await call("${HOST_CALLS.namespaces}", "null"));
    // A name that is not a tool fails where code reads it, naming the tool it may have meant (a
    // server's prefix left off, most often), rather than as a bare "not a function" at the call.
    // Symbols and the names a promise, JSON or a conversion look up stay undefined.
    const names = Object.keys(tools);
    const LOOKUPS = ["then", "toJSON", "constructor", "valueOf", "toString", "inspect", "prototype", "__proto__"];
    const notATool = key => {
      const prefix = key.lastIndexOf("__");
      const bare = (prefix < 0 ? key : key.slice(prefix + 2)).toLowerCase();
      const meant = names.filter(name => name.toLowerCase() === key.toLowerCase() || name.toLowerCase().endsWith("__" + bare));
      return new TypeError("tools." + key + " is not a tool." +
        (meant.length ? " Did you mean " + meant.slice(0, 3).map(name => "tools." + name).join(" or ") + "?" : "") +
        " tools.search(\\"what it does\\") finds tools; tools.describe(name) shows one's arguments.");
    };
    const frozen = Object.freeze(tools);
    const guarded = new Proxy(frozen, {
      get: (target, key) => {
        if (typeof key !== "string" || key in target || LOOKUPS.includes(key)) return target[key];
        throw notATool(key);
      },
    });
    Object.defineProperty(globalThis, "tools", { value: guarded });
  };
  const formatError = error => {
    try { return slice(StringCtor(error && error.message || error), 0, 2048); }
    catch { return "Sandbox execution failed"; }
  };
  // Settles with the execution: what the code's promise resolved to is sent as its return value.
  const finish = promise => promise.then(value => {
    if (value === undefined) return;
    const json = typeof value === "string" ? undefined : stringify(value);
    send(json ?? StringCtor(value), json === undefined ? 2 : 6);
  });
  return [install, formatError, finish];
})
`;
