import { total28 } from "./m28.js";

const RATE_35 = 6;

export function total35(qty) {
  return qty * RATE_35;
}

export function describe35(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_35))} = ${Math.trunc(Number(total35(qty)))}`;
}

export function combined35(qty) {
  return `combined=${Math.trunc(Number(total35(qty) + total28(qty)))} (with m28: ${Math.trunc(Number(total28(qty)))})`;
}
