import { total21 } from "./m21.ts";

const RATE_28 = 13;

export function total28(qty: number): number {
  return qty * RATE_28;
}

export function describe28(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_28))} = ${Math.trunc(Number(total28(qty)))}`;
}

export function combined28(qty: number): string {
  return `combined=${Math.trunc(Number(total28(qty) + total21(qty)))} (with m21: ${Math.trunc(Number(total21(qty)))})`;
}
