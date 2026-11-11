const RATE_08 = 3;

export function total08(qty) {
  return qty * RATE_08;
}

export function describe08(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_08))} = ${Math.trunc(Number(total08(qty)))}`;
}
