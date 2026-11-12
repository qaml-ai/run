import { total28 } from "./m28.ts";

const RATE_35 = 6;

export function total35(qty: number): number {
  return qty * RATE_35;
}

export function describe35(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_35))} = ${Math.trunc(Number(total35(qty)))}`;
}

export function combined35(qty: number): string {
  return `combined=${Math.trunc(Number(total35(qty) + total28(qty)))} (with m28: ${Math.trunc(Number(total28(qty)))})`;
}
