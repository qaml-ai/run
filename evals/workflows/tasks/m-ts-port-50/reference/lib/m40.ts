const RATE_40 = 15;

export function total40(qty: number): number {
  return qty * RATE_40;
}

export function describe40(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_40))} = ${Math.trunc(Number(total40(qty)))}`;
}
