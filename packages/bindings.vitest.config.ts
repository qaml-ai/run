import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
// Vue, Svelte and Solid bindings (Solid needs its browser build, and a DOM, to be reactive in a test).
export default defineConfig({
  resolve: { alias: { "@camelai/agent-runtime/chat": at("../clients/chat.ts") }, conditions: ["browser"] },
  test: { include: ["{vue,svelte,solid}/test/**/*.test.ts"], root: at("."), environment: "node" },
});
