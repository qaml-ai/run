const RATE_11 = 19;

export function total11(qty: number): number {
  return qty * RATE_11;
}

export function describe11(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_11))} = ${Math.trunc(Number(total11(qty)))}`;
}
