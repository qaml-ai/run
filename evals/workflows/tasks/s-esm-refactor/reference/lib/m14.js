import { total07 } from "./m07.js";

const RATE_14 = 5;

export function total14(qty) {
  return qty * RATE_14;
}

export function describe14(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_14))} = ${Math.trunc(Number(total14(qty)))}`;
}

export function combined14(qty) {
  return `combined=${Math.trunc(Number(total14(qty) + total07(qty)))} (with m07: ${Math.trunc(Number(total07(qty)))})`;
}
