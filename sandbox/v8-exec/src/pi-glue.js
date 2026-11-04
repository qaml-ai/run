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
  const bridge = (kind, a, b, c) => {
    if (finished) return;
    if (kind === "call" || kind === "global") {
      issued++;
      send(stringify({ type: "call", id: a, target: kind === "call" ? "tool" : "global", name: b, args: c }));
    } else if (kind === "output") {
      // One message stays within a bridge frame (send's limit, pi.rs): text past what a script prints in all is cut
      // here (pi.rs `bounded` cuts the rest), and an image too large to send is noted instead.
      const item = a === "image"
        ? b.length > FRAME_CHARS ? { type: "text", text: `[An image of ${b.length} base64 characters was left out: too large to show]` } : { type: "image", data: b, mimeType: c }
        : { type: "text", text: b.length > TEXT_CHARS ? b.slice(0, TEXT_CHARS) : b, ...(a === "console" ? { console: true } : {}) };
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
      api.settle(message.id, message.ok, message.payload, message.properties);
    },
    fn => api.run(fn),
    () => { api.stalled(); return finished; },
    () => { for (const name of ["SharedArrayBuffer", "Atomics", "WebAssembly"]) delete globalThis[name]; },
  ];
})
