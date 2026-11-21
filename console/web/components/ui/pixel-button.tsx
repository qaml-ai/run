import type { ComponentPropsWithoutRef, CSSProperties } from "react";
import { Loader2Icon } from "lucide-react";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

type PixelButtonVariant = "primary" | "secondary" | "ghost";
type PixelButtonSize = "default" | "sm" | "lg" | "hero";

type PixelButtonBaseProps = {
  variant?: PixelButtonVariant;
  size?: PixelButtonSize;
  asChild?: boolean;
  loading?: boolean;
};

type PixelButtonAnchorProps = PixelButtonBaseProps &
  Omit<ComponentPropsWithoutRef<"a">, keyof PixelButtonBaseProps> & {
    href: string;
  };

type PixelButtonNativeProps = PixelButtonBaseProps &
  Omit<ComponentPropsWithoutRef<"button">, keyof PixelButtonBaseProps> & {
    href?: never;
  };

export type PixelButtonProps = PixelButtonAnchorProps | PixelButtonNativeProps;

const variants: Record<PixelButtonVariant, string> = {
  primary: "bg-foreground text-background hover:opacity-80",
  secondary:
    "border border-border text-foreground bg-background/55 hover:border-foreground/50",
  ghost:
    "text-muted-foreground hover:text-foreground underline-offset-4 hover:underline px-0 py-0",
};

const sizes: Record<PixelButtonSize, string> = {
  sm: "h-6 px-3 text-[10px]",
  default: "h-7 px-4",
  lg: "h-8 px-5",
  hero: "h-10 px-5",
};

const fontStyle: CSSProperties = {
  fontFamily: '"Silkscreen", monospace',
};

export function PixelButton({
  variant = "primary",
  size = "default",
  asChild = false,
  loading = false,
  className,
  style,
  href,
  children,
  ...props
}: PixelButtonProps) {
  const classes = cn(
    "inline-flex shrink-0 items-center justify-center gap-2 uppercase select-none rounded-none transition text-[11px] leading-none tracking-[0.22em] disabled:opacity-50 disabled:pointer-events-none",
    variants[variant],
    sizes[size],
    className,
  );
  const styles = { ...style, ...fontStyle };
  const loadingIndicator = loading ? (
    <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
  ) : null;

  if (asChild) {
    return (
      <Slot.Root
        {...(props as Omit<PixelButtonNativeProps, keyof PixelButtonBaseProps | "className" | "style" | "href">)}
        className={classes}
        style={styles}
      >
        {loadingIndicator}
        <Slot.Slottable>{children}</Slot.Slottable>
      </Slot.Root>
    );
  }

  if (href !== undefined) {
    return (
      <a
        {...(props as Omit<PixelButtonAnchorProps, keyof PixelButtonBaseProps | "className" | "style" | "href">)}
        href={href}
        className={classes}
        style={styles}
      >
        {loadingIndicator}
        {children}
      </a>
    );
  }

  return (
    <button
      {...(props as Omit<PixelButtonNativeProps, keyof PixelButtonBaseProps | "className" | "style" | "href">)}
      type={(props as PixelButtonNativeProps).type ?? "button"}
      className={classes}
      style={styles}
    >
      {loadingIndicator}
      {children}
    </button>
  );
}
