const RATE_38 = 18;

export function total38(qty) {
  return qty * RATE_38;
}

export function describe38(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_38))} = ${Math.trunc(Number(total38(qty)))}`;
}
