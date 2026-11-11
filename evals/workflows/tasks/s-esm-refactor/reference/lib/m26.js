const RATE_26 = 7;

export function total26(qty) {
  return qty * RATE_26;
}

export function describe26(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_26))} = ${Math.trunc(Number(total26(qty)))}`;
}
