const RATE_01 = 16;

export function total01(qty) {
  return qty * RATE_01;
}

export function describe01(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_01))} = ${Math.trunc(Number(total01(qty)))}`;
}
