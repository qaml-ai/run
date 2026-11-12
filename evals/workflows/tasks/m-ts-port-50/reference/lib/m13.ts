const RATE_13 = 4;

export function total13(qty: number): number {
  return qty * RATE_13;
}

export function describe13(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_13))} = ${Math.trunc(Number(total13(qty)))}`;
}
