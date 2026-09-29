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
