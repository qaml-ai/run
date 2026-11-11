const RATE_34 = 8;

export function total34(qty) {
  return qty * RATE_34;
}

export function describe34(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_34))} = ${Math.trunc(Number(total34(qty)))}`;
}
