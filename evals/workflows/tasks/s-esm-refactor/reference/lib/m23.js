const RATE_23 = 11;

export function total23(qty) {
  return qty * RATE_23;
}

export function describe23(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_23))} = ${Math.trunc(Number(total23(qty)))}`;
}
