import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  resolve: {
    alias: {
      "@camelai/run/chat": at("../../clients/chat.ts"),
      "@camelai/run/markdown": at("../../clients/markdown.ts"),
      "@camelai/run-react/ui": at("./src/ui/index.tsx"),
      "@camelai/run-react": at("./src/index.tsx"),
    },
  },
  esbuild: { jsx: "automatic" },
  test: { environment: "jsdom", include: ["test/**/*.test.{ts,tsx}"], setupFiles: ["test/setup.ts"], root: at(".") },
});
