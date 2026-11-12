const RATE_05 = 18;

export function total05(qty: number): number {
  return qty * RATE_05;
}

export function describe05(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_05))} = ${Math.trunc(Number(total05(qty)))}`;
}
