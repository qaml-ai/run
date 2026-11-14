// Control time inside workerd: mocking Date in the Node test cannot reach it.
// Keep every admission in the same UTC minute without freezing async timers.
Date.now = () => Date.UTC(2026, 10, 9, 12, 0, 10);

export * from "../src/index.ts";
export { default } from "../src/index.ts";
export { CamelfsStub } from "./camelfs-stub.ts";
