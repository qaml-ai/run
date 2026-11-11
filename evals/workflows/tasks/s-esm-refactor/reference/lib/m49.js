import { total42 } from "./m42.js";

const RATE_49 = 18;

export function total49(qty) {
  return qty * RATE_49;
}

export function describe49(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_49))} = ${Math.trunc(Number(total49(qty)))}`;
}

export function combined49(qty) {
  return `combined=${Math.trunc(Number(total49(qty) + total42(qty)))} (with m42: ${Math.trunc(Number(total42(qty)))})`;
}
