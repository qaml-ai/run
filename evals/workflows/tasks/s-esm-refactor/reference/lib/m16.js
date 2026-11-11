const RATE_16 = 17;

export function total16(qty) {
  return qty * RATE_16;
}

export function describe16(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_16))} = ${Math.trunc(Number(total16(qty)))}`;
}
