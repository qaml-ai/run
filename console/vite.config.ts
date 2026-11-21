import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/postcss";
import { fileURLToPath } from "node:url";

// Built into console/dist and served by camelrun-v2-ingress at /console/.
export default defineConfig({
  root: fileURLToPath(new URL("./web", import.meta.url)),
  base: "/console/",
  plugins: [react()],
  define: { "import.meta.env.VITE_CONSOLE_BUILD": JSON.stringify(process.env.AGENT_RELEASE ?? `build-${Date.now().toString(36)}`) },
  resolve: {
    alias: {
      "@camelai/run-react": fileURLToPath(new URL("../packages/react/src/index.tsx", import.meta.url)),
      "@camelai/run/chat": fileURLToPath(new URL("../clients/chat.ts", import.meta.url)),
      "@camelai/run/markdown": fileURLToPath(new URL("../clients/markdown.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./web", import.meta.url)),
    },
  },
  css: { postcss: { plugins: [tailwind()] } },
  // Fonts stay files: inlined as data: URIs, the console's CSP (fonts from 'self') would block them.
  // admin.html is the team's ops dashboard served at /ops/ by camelrun-v2-ingress.
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./web/index.html", import.meta.url)),
        admin: fileURLToPath(new URL("./web/admin.html", import.meta.url)),
      },
    },
    assetsInlineLimit: file => /\.(woff2?|ttf|otf)$/.test(file) ? false : undefined,
  },
  server: {
    proxy: {
      "/console/v2": "http://127.0.0.1:8787",
      "/console/auth": "http://127.0.0.1:8787",
      "/ops/api": "http://127.0.0.1:8787",
      "/v2": "http://127.0.0.1:8787",
    },
  },
});
