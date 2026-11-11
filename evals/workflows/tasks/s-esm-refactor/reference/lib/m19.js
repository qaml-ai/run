const RATE_19 = 2;

export function total19(qty) {
  return qty * RATE_19;
}

export function describe19(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_19))} = ${Math.trunc(Number(total19(qty)))}`;
}
