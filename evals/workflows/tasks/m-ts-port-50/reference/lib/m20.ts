const RATE_20 = 16;

export function total20(qty: number): number {
  return qty * RATE_20;
}

export function describe20(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_20))} = ${Math.trunc(Number(total20(qty)))}`;
}
