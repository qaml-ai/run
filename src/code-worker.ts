import { parentPort, type MessagePort } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Rpc } from "./rpc.ts";
import { runSandbox } from "./quickjs-sandbox.ts";
import type { WireMessage } from "./protocol.ts";

// One pooled sandbox worker. It compiles QuickJS once; each execution arrives
// with its own MessagePort and runs in a fresh WASM instance, runtime and context.
const quickjs = createRequire(import.meta.url).resolve("quickjs-emscripten");
const wasm = createRequire(quickjs).resolve("@jitl/quickjs-wasmfile-release-sync/wasm");
const wasmModule = await WebAssembly.compile(await readFile(wasm));

parentPort!.on("message", ({ port, cancel, id }: { port: MessagePort; cancel: SharedArrayBuffer; id: number }) => {
  const rpc = new Rpc(message => port.postMessage(message));
  const closed = new AbortController();
  let used = false;
  port.on("message", message => { void rpc.receive(message as WireMessage); });
  port.once("close", () => {
    rpc.close("Codemode ended");
    closed.abort();
    if (!used) parentPort!.postMessage({ idle: id });
  });
  rpc.handler = async (method, params) => {
    if (method !== "execute" || used) throw new Error("Codemode port accepts one execution");
    used = true;
    try {
      return await runSandbox({
        wasmModule, cancel: new Int32Array(cancel), signal: closed.signal,
        code: params.code, tools: params.tools, timeoutMs: params.timeoutMs, maxOutputCharacters: params.maxOutputCharacters,
        call: (name, args) => rpc.request("tool", { name, args }),
        onOutput: text => rpc.send({ type: "event", event: { type: "output", text } }),
      });
    } finally { parentPort!.postMessage({ idle: id }); }
  };
});
parentPort!.postMessage("ready");
