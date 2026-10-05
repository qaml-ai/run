import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/postcss";
import { fileURLToPath } from "node:url";

// Built into console/dist and served by the runtime at /console/.
export default defineConfig({
  root: fileURLToPath(new URL("./web", import.meta.url)),
  base: "/console/",
  plugins: [react()],
  define: { "import.meta.env.VITE_CONSOLE_BUILD": JSON.stringify(process.env.AGENT_RELEASE ?? `build-${Date.now().toString(36)}`) },
  resolve: { alias: { "@": fileURLToPath(new URL("./web", import.meta.url)) } },
  css: { postcss: { plugins: [tailwind()] } },
  // Fonts stay files: inlined as data: URIs, the console's CSP (fonts from 'self') would block them.
  // admin.html is the team's admin site (src/admin-site.ts), served on its own hostname.
  build: { outDir: "../dist", emptyOutDir: true, rollupOptions: { input: { main: fileURLToPath(new URL("./web/index.html", import.meta.url)), admin: fileURLToPath(new URL("./web/admin.html", import.meta.url)) } }, assetsInlineLimit: file => /\.(woff2?|ttf|otf)$/.test(file) ? false : undefined },
  server: { proxy: { "/v1": "http://127.0.0.1:8790", "/console/auth": "http://127.0.0.1:8790", "/console/discord": "http://127.0.0.1:8790" } },
});
