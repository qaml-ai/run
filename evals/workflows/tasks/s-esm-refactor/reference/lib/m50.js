const RATE_50 = 11;

export function total50(qty) {
  return qty * RATE_50;
}

export function describe50(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_50))} = ${Math.trunc(Number(total50(qty)))}`;
}
