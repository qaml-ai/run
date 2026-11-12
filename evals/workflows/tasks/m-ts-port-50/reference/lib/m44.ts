const RATE_44 = 11;

export function total44(qty: number): number {
  return qty * RATE_44;
}

export function describe44(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_44))} = ${Math.trunc(Number(total44(qty)))}`;
}
