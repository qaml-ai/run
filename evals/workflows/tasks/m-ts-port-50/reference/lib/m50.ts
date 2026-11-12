const RATE_50 = 11;

export function total50(qty: number): number {
  return qty * RATE_50;
}

export function describe50(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_50))} = ${Math.trunc(Number(total50(qty)))}`;
}
