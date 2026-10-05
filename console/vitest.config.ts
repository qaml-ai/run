import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./web", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  test: { root: fileURLToPath(new URL(".", import.meta.url)), environment: "jsdom", setupFiles: ["test/setup.ts"], include: ["test/**/*.test.{ts,tsx}"] },
});
