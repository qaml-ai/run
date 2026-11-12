const RATE_16 = 17;

export function total16(qty: number): number {
  return qty * RATE_16;
}

export function describe16(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_16))} = ${Math.trunc(Number(total16(qty)))}`;
}
