import { AsyncLocalStorage } from "node:async_hooks";
export const evidence = new AsyncLocalStorage<{ backend: string | null }>();
