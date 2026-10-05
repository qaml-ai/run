import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FullLogo } from "@/components/ui/logo";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AdminPage } from "@/pages/admin";
import "@fontsource-variable/figtree";
import "@fontsource-variable/geist-mono";
import "./style.css";

// The team's admin site (src/admin-site.ts): its own hostname behind Cloudflare Access, which signs people in.
const dark = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches);
applyTheme();
dark.addEventListener("change", applyTheme);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <div className="min-h-dvh">
        <header className="border-b px-4 py-4 md:px-10"><FullLogo className="h-5 w-auto" /></header>
        <main className="px-4 py-6 md:px-10 md:py-8"><div className="mx-auto max-w-6xl"><AdminPage /></div></main>
      </div>
    </TooltipProvider>
  </StrictMode>,
);
