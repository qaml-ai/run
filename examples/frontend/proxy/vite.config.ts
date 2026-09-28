import devServer from "@hono/vite-dev-server";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Vite serves the page; /api/* goes to the Hono app in server.ts.
export default defineConfig({ plugins: [react(), devServer({ entry: "server.ts", exclude: [/^(?!\/api\/).*/] })] });
