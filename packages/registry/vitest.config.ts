import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  resolve: {
    alias: {
      "@camelai/run/chat": at("../../clients/chat.ts"),
      "@camelai/run/markdown": at("../../clients/markdown.ts"),
      "@camelai/run-react": at("../react/src/index.tsx"),
      "@/components/ui/button": at("./test/stubs/button.tsx"),
      "@/lib/utils": at("./test/stubs/utils.ts"),
    },
  },
  esbuild: { jsx: "automatic" },
  test: { environment: "jsdom", include: ["test/**/*.test.{ts,tsx}"], setupFiles: ["../react/test/setup.ts"], root: at(".") },
});
