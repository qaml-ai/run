import { total35 } from "./m35.ts";

const RATE_42 = 16;

export function total42(qty: number): number {
  return qty * RATE_42;
}

export default function describe42(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_42))} = ${Math.trunc(Number(total42(qty)))}`;
}

export function percent42(part: number, whole: number): string {
  return `${Math.trunc(Number(part / whole * 100))}% of ${String('pallets')} (${JSON.stringify({ part: part, whole: whole })})`;
}

export function combined42(qty: number): string {
  return `combined=${Math.trunc(Number(total42(qty) + total35(qty)))} (with m35: ${Math.trunc(Number(total35(qty)))})`;
}
