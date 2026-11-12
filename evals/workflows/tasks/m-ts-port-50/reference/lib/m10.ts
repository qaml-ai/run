const RATE_10 = 12;

export function total10(qty: number): number {
  return qty * RATE_10;
}

export function describe10(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_10))} = ${Math.trunc(Number(total10(qty)))}`;
}
