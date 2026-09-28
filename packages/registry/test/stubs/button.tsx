// The shadcn Button, as `npx shadcn add button` installs it (trimmed: no Slot), for typechecking and tests.
import type { ButtonHTMLAttributes } from "react";
import { cn } from "./utils.ts";

type Variant = "default" | "outline" | "ghost" | "secondary" | "destructive" | "link";
type Size = "default" | "sm" | "lg" | "icon";
export function Button({ className, variant = "default", size = "default", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button data-variant={variant} data-size={size} className={cn("inline-flex items-center justify-center", className)} {...props} />;
}
