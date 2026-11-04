// Trusted Pi transport and deterministic intrinsics. Evaluated before the prelude locks the realm.
(function (send, bootstrap, dataJson) {
  "use strict";
  const data = JSON.parse(dataJson);
  const parse = JSON.parse, stringify = JSON.stringify;
  let now = data.deterministic?.startedAt ?? 0;
  const startedAt = now;
  let state = data.deterministic?.seed ?? 0;
  // V8 has a console of its own; the prelude defines its own (QuickJS has none).
  for (const name of ["SharedArrayBuffer", "Atomics", "WebAssembly", "WeakRef", "FinalizationRegistry", "Temporal", "console"]) delete globalThis[name];
  const FILES = "files are the agent's file tools, called as await tools.read({ path }), await tools.write({ path, content }) and await tools.ls({ path })";
  // js_exec's tool finders, which are Pi's globals now: a script calling one is told which.
  const FINDERS = { search: "searchTools(query)", describe: "describeTool(name)", namespaces: "describeNamespace(name)" };
  // js_exec's `fs`, the calls scripts still make, on the agent's file tools (the running script's `tools`), asynchronous as
  // they are: text in and out (bytes written as base64). Without the file tools in code, it says what there is instead.
  let scriptTools;
  const fileTool = (name, args) => {
    if (!scriptTools || !Reflect.has(scriptTools, name)) throw new ReferenceError(`fs is not defined in codemode: ${FILES}`);
    return scriptTools[name](args);
  };
  const readText = async path => {
    let text = "", offset = 1;
    for (;;) {
      const read = await fileTool("read", offset > 1 ? { path: String(path), offset } : { path: String(path) });
      const chunk = typeof read?.content === "string" ? read.content : String(read?.content ?? "");
      if (read?.truncated !== true && read?.truncation?.truncated !== true) return text + chunk;
      text += `${chunk}\n`;
      offset += chunk.split("\n").length;
    }
  };
  const bytes = data => data instanceof Uint8Array || data instanceof ArrayBuffer;
  // No btoa in a bare isolate.
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const base64 = data => {
    const view = new Uint8Array(data);
    let out = "";
    for (let i = 0; i < view.length; i += 3) {
      const n = (view[i] << 16) | ((view[i + 1] ?? 0) << 8) | (view[i + 2] ?? 0);
      out += ALPHABET[n >> 18 & 63] + ALPHABET[n >> 12 & 63] + (i + 1 < view.length ? ALPHABET[n >> 6 & 63] : "=") + (i + 2 < view.length ? ALPHABET[n & 63] : "=");
    }
    return out;
  };
  const writeData = (path, data) => fileTool("write", bytes(data) ? { path: String(path), content: base64(data), encoding: "base64" } : { path: String(path), content: String(data) });
  const entries = async path => (await fileTool("ls", { path: String(path) }))?.entries ?? [];
  const fs = {
    readFile: path => readText(path),
    writeFile: async (path, data) => { await writeData(path, data); },
    appendFile: async (path, data) => { const before = await fs.exists(path) ? await readText(path) : ""; await writeData(path, before + String(data)); },
    readdir: async path => (await entries(path)).map(entry => entry.name),
    exists: async path => {
      const at = String(path).replace(/\/+$/, ""), slash = at.lastIndexOf("/");
      try { return (await entries(slash > 0 ? at.slice(0, slash) : "/")).some(entry => entry.name === at.slice(slash + 1)); } catch { return false; }
    },
    // The file tools make a file's directories as they write it.
    mkdir: async () => {}, mkdirSync: () => {},
  };
  for (const name of ["readFile", "writeFile", "appendFile", "readdir", "exists"]) {
    fs[`${name}Sync`] = () => { throw new TypeError(`fs.${name}Sync is not in codemode, where the file tools are asynchronous: use await fs.${name}(…)`); };
  }
  fs.existsSync = () => { throw new TypeError("fs.existsSync is not in codemode, where the file tools are asynchronous: use await fs.exists(path)"); };
  fs.promises = fs;
  Object.freeze(fs);
  const shim = () => { if (!scriptTools || !Reflect.has(scriptTools, "read")) throw new ReferenceError(`fs is not defined in codemode: ${FILES}`); return fs; };
  Object.defineProperty(globalThis, "fs", { configurable: false, get: shim });
  Object.defineProperty(globalThis, "require", { configurable: false, get() {
    return name => {
      if (["fs", "node:fs", "fs/promises", "node:fs/promises"].includes(name)) return shim();
      throw new ReferenceError(`require is not defined in codemode: there are no modules, and ${FILES}`);
    };
  } });
  if (data.deterministic) {
    const NativeDate = Date;
    function VirtualDate(...args) {
      if (!new.target) return new NativeDate(now).toString();
      return Reflect.construct(NativeDate, args.length ? args : [now], new.target);
    }
    VirtualDate.prototype = NativeDate.prototype;
    Object.defineProperty(VirtualDate.prototype, "constructor", { value: VirtualDate, writable: true, configurable: true });
    Object.defineProperties(VirtualDate, {
      now: { value: () => now }, parse: { value: NativeDate.parse }, UTC: { value: NativeDate.UTC },
    });
    globalThis.Date = VirtualDate;
    globalThis.performance = { now: () => now - startedAt, timeOrigin: startedAt };
    Math.random = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = Math.imul(state ^ (state >>> 15), 1 | state);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    // Intl's omitted date argument reads V8's real clock unless intercepted too.
    const NativeFormat = Intl.DateTimeFormat;
    const proto = NativeFormat.prototype;
    const format = Object.getOwnPropertyDescriptor(proto, "format").get;
    const parts = proto.formatToParts;
    const bound = new WeakMap();
    Object.defineProperty(proto, "format", { configurable: true, get() {
      if (!bound.has(this)) {
        const fn = format.call(this);
        bound.set(this, value => fn(value === undefined ? now : value));
      }
      return bound.get(this);
    } });
    proto.formatToParts = function (value) { return parts.call(this, value === undefined ? now : value); };
    function DateTimeFormat(...args) { return Reflect.construct(NativeFormat, args); }
    DateTimeFormat.prototype = proto;
    Object.defineProperty(proto, "constructor", { value: DateTimeFormat, writable: true, configurable: true });
    DateTimeFormat.supportedLocalesOf = NativeFormat.supportedLocalesOf;
    Intl.DateTimeFormat = DateTimeFormat;
  }
  // Within send's frame (MAX_FRAME_BYTES / 2 characters, main.rs) with room for the envelope; EMIT_CHARS of text.
  const FRAME_CHARS = 2 * 1024 * 1024 - 64 * 1024, TEXT_CHARS = 128000;
  let current = 0, issued = 0, finished = false;
  // At most CONCURRENT_TOOLS (main.rs) calls are out at once; the rest wait here, in order, and go as answers come
  // back, so a script may await any number of calls at once (Promise.all over many delegates) within TOOL_CALLS.
  const CONCURRENT = 32, waiting = [];
  let out = 0;
  const call = frame => { issued++; out++; send(stringify(frame)); };
  const bridge = (kind, a, b, c) => {
    if (finished) return;
    if (kind === "call" || kind === "global") {
      const frame = { type: "call", id: a, target: kind === "call" ? "tool" : "global", name: b, args: c };
      if (out < CONCURRENT && !waiting.length) call(frame);
      else waiting.push(frame);
    } else if (kind === "output") {
      // Text is made well formed (a lone surrogate, half an emoji, as U+FFFD): the bridge's JSON refuses one.
      // One message stays within a bridge frame (send's limit, pi.rs): text past what a script prints in all is cut
      // here (pi.rs `bounded` cuts the rest), and an image too large to send is noted instead.
      const item = a === "image"
        ? b.length > FRAME_CHARS ? { type: "text", text: `[An image of ${b.length} base64 characters was left out: too large to show]` } : { type: "image", data: b, mimeType: c }
        : { type: "text", text: (b.length > TEXT_CHARS ? b.slice(0, TEXT_CHARS) : b).toWellFormed(), ...(a === "console" ? { console: true } : {}) };
      send(stringify({ type: "output", item }));
    } else if (kind === "done") {
      finished = true;
      // A return value (or an error) too large for a frame fails the script, saying so, rather than the sandbox.
      if ((b?.length ?? 0) + (a ? c?.length ?? 0 : 0) > FRAME_CHARS) {
        const what = a ? "return value" : "error";
        a = false;
        b = stringify({ name: "RangeError", message: `The script's ${what} is too large to return (over ${FRAME_CHARS} characters): return less, or write it to a file` });
      }
      send(stringify({ type: "done", ok: a, ...(a ? { value: b, writes: c } : { error: b }),
        ...(data.deterministic ? { during: { seq: current, issued } } : {}) }));
    }
  };
  const api = bootstrap(bridge, stringify(data.tools), stringify(data.globals), stringify(data.store));
  return [
    json => {
      const message = parse(json);
      current = message.seq ?? current;
      now = Math.max(now, message.now ?? now);
      out--;
      while (out < CONCURRENT && waiting.length && !finished) call(waiting.shift());
      api.settle(message.id, message.ok, message.payload, message.properties);
    },
    fn => api.run((tools, ...rest) => fn(scriptTools = new Proxy(tools, { get(target, key, receiver) {
      if (typeof key === "string" && Object.hasOwn(FINDERS, key) && !Reflect.has(target, key)) {
        throw new TypeError(`tools.${key} is not in codemode: call ${FINDERS[key]}, a global, as in await ${FINDERS[key].replace(/\(.*\)/, '("…")')}`);
      }
      return Reflect.get(target, key, receiver);
    } }), ...rest)),
    () => { api.stalled(); return finished; },
    () => { for (const name of ["SharedArrayBuffer", "Atomics", "WebAssembly"]) delete globalThis[name]; },
  ];
})
