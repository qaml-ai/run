const RATE_43 = 11;

export function total43(qty) {
  return qty * RATE_43;
}

export function describe43(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_43))} = ${Math.trunc(Number(total43(qty)))}`;
}
