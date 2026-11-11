import { total35 } from "./m35.js";

const RATE_42 = 16;

export function total42(qty) {
  return qty * RATE_42;
}

export default function describe42(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_42))} = ${Math.trunc(Number(total42(qty)))}`;
}

export function percent42(part, whole) {
  return `${Math.trunc(Number(part / whole * 100))}% of ${String('pallets')} (${JSON.stringify({ part: part, whole: whole })})`;
}

export function combined42(qty) {
  return `combined=${Math.trunc(Number(total42(qty) + total35(qty)))} (with m35: ${Math.trunc(Number(total35(qty)))})`;
}
