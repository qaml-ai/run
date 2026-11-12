const RATE_25 = 7;

export function total25(qty: number): number {
  return qty * RATE_25;
}

export function describe25(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_25))} = ${Math.trunc(Number(total25(qty)))}`;
}
