import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OpsPage } from "@/pages/ops/ops-page";
import "@fontsource-variable/figtree";
import "@fontsource-variable/geist-mono";
import "./style.css";

// The team's ops dashboard (src/admin-site.ts): a path of the runtime's hostname (/ops), or a hostname of its own,
// behind Cloudflare Access, which signs people in.
const dark = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches);
applyTheme();
dark.addEventListener("change", applyTheme);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <OpsPage />
    </TooltipProvider>
  </StrictMode>,
);
