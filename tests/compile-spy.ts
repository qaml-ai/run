// Imported first by tests that check what this thread compiles: it records every
// string compiled through the Function constructors (as globals or through
// .constructor) and indirect eval, from before any runtime module loads.
export const compiled: string[] = [];
const spy = <T extends Function>(target: T) => new Proxy(target, {
  apply(fn, self, args) { compiled.push(args.join("\n")); return Reflect.apply(fn, self, args); },
  construct(fn, args, newTarget) { compiled.push(args.join("\n")); return Reflect.construct(fn, args, newTarget); },
});
for (const prototype of [Function.prototype, Object.getPrototypeOf(async function () {}), Object.getPrototypeOf(function* () {}), Object.getPrototypeOf(async function* () {})]) {
  Object.defineProperty(prototype, "constructor", { value: spy(prototype.constructor), configurable: true, writable: true });
}
globalThis.Function = spy(globalThis.Function);
globalThis.eval = spy(globalThis.eval);
