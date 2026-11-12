const RATE_23 = 11;

export function total23(qty: number): number {
  return qty * RATE_23;
}

export function describe23(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_23))} = ${Math.trunc(Number(total23(qty)))}`;
}
