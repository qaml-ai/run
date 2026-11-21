import * as React from "react";
import { DropdownMenu as MenuPrimitive } from "radix-ui";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const DropdownMenu = (props: React.ComponentProps<typeof MenuPrimitive.Root>) => <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
const DropdownMenuTrigger = (props: React.ComponentProps<typeof MenuPrimitive.Trigger>) => <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
const DropdownMenuGroup = (props: React.ComponentProps<typeof MenuPrimitive.Group>) => <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
const DropdownMenuRadioGroup = (props: React.ComponentProps<typeof MenuPrimitive.RadioGroup>) => <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
const DropdownMenuSub = (props: React.ComponentProps<typeof MenuPrimitive.Sub>) => <MenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;

const content = "bg-popover text-popover-foreground border-ring z-50 min-w-40 overflow-x-hidden overflow-y-auto border p-1 shadow-md max-h-(--radix-dropdown-menu-content-available-height) origin-(--radix-dropdown-menu-content-transform-origin) data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 duration-100";
const item = "focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent relative flex w-full cursor-default items-center gap-2.5 px-2.5 py-2 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

function DropdownMenuContent({ className, sideOffset = 4, ...props }: React.ComponentProps<typeof MenuPrimitive.Content>) {
  return <MenuPrimitive.Portal><MenuPrimitive.Content data-slot="dropdown-menu-content" sideOffset={sideOffset} className={cn(content, className)} {...props} /></MenuPrimitive.Portal>;
}

function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Item>) {
  return <MenuPrimitive.Item data-slot="dropdown-menu-item" className={cn(item, className)} {...props} />;
}

/** A choice of one; the check marks the selected row. */
function DropdownMenuRadioItem({ className, children, ...props }: React.ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem data-slot="dropdown-menu-radio-item" className={cn(item, "data-[state=checked]:bg-accent pr-8", className)} {...props}>
      {children}
      <span className="pointer-events-none absolute right-2.5 flex items-center"><MenuPrimitive.ItemIndicator><CheckIcon className="size-3.5" /></MenuPrimitive.ItemIndicator></span>
    </MenuPrimitive.RadioItem>
  );
}

/** A Silkscreen section label, as table heads and eyebrows are set. */
function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label data-slot="dropdown-menu-label" className={cn("text-muted-foreground px-2.5 pt-2 pb-1 text-[10px] uppercase tracking-[0.3em]", className)} style={{ fontFamily: '"Silkscreen", monospace' }} {...props} />;
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator data-slot="dropdown-menu-separator" className={cn("bg-border -mx-1 my-1 h-px", className)} {...props} />;
}

function DropdownMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof MenuPrimitive.SubTrigger>) {
  return <MenuPrimitive.SubTrigger data-slot="dropdown-menu-sub-trigger" className={cn(item, className)} {...props}>{children}<ChevronRightIcon className="ml-auto size-4" /></MenuPrimitive.SubTrigger>;
}

function DropdownMenuSubContent({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.SubContent>) {
  return <MenuPrimitive.Portal><MenuPrimitive.SubContent data-slot="dropdown-menu-sub-content" className={cn(content, "max-h-(--radix-dropdown-menu-content-available-height)", className)} {...props} /></MenuPrimitive.Portal>;
}

export {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
};
