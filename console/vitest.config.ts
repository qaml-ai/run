import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@camelai/run-react": fileURLToPath(new URL("../packages/react/src/index.tsx", import.meta.url)), "@camelai/run/chat": fileURLToPath(new URL("../clients/chat.ts", import.meta.url)), "@camelai/run/markdown": fileURLToPath(new URL("../clients/markdown.ts", import.meta.url)), "@": fileURLToPath(new URL("./web", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  test: { root: fileURLToPath(new URL(".", import.meta.url)), environment: "jsdom", setupFiles: ["test/setup.ts"], include: ["test/**/*.test.{ts,tsx}"] },
});
