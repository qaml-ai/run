import { total14 } from "./m14.js";

const RATE_21 = 19;

export function total21(qty) {
  return qty * RATE_21;
}

export function describe21(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_21))} = ${Math.trunc(Number(total21(qty)))}`;
}

export function percent21(part, whole) {
  return `${Math.trunc(Number(part / whole * 100))}% of ${String('tickets')} (${JSON.stringify({ part: part, whole: whole })})`;
}

export function combined21(qty) {
  return `combined=${Math.trunc(Number(total21(qty) + total14(qty)))} (with m14: ${Math.trunc(Number(total14(qty)))})`;
}
