import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  resolve: {
    alias: {
      "@camelai/agent-runtime/chat": at("../../clients/chat.ts"),
      "@camelai/agent-runtime/markdown": at("../../clients/markdown.ts"),
      "@camelai/agent-runtime-react/ui": at("./src/ui/index.tsx"),
      "@camelai/agent-runtime-react": at("./src/index.tsx"),
    },
  },
  esbuild: { jsx: "automatic" },
  test: { environment: "jsdom", include: ["test/**/*.test.{ts,tsx}"], setupFiles: ["test/setup.ts"], root: at(".") },
});
