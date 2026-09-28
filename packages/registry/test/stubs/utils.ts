// shadcn's `cn`, without tailwind-merge, for typechecking and tests.
export function cn(...inputs: (string | false | null | undefined)[]) { return inputs.filter(Boolean).join(" "); }
