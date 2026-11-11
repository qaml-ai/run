const RATE_40 = 15;

export function total40(qty) {
  return qty * RATE_40;
}

export function describe40(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_40))} = ${Math.trunc(Number(total40(qty)))}`;
}
