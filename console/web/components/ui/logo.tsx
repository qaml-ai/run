import { cn } from "@/lib/utils";
import darkLogo from "@/assets/camelai-logo-dark.svg";
import lightLogo from "@/assets/camelai-logo-light.svg";

// Theme switching relies on display classes on the imgs — control outer
// visibility with a wrapper element, never via the className prop.
export function FullLogo({ className }: { className?: string }) {
  return (
    <>
      <img src={lightLogo} alt="camelAI" className={cn("block dark:hidden", className)} />
      <img src={darkLogo} alt="camelAI" className={cn("hidden dark:block", className)} />
    </>
  );
}

/** The console names the product, camelRun: camelAI's mark beside the name, in the body face. */
export function RunLogo({ className }: { className?: string }) {
  return (
    <span className={cn("text-foreground inline-flex items-center gap-2 text-base font-semibold tracking-tight", className)}>
      <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-5 dark:invert" />camelRun
    </span>
  );
}
