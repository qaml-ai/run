const RATE_08 = 3;

export function total08(qty: number): number {
  return qty * RATE_08;
}

export function describe08(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_08))} = ${Math.trunc(Number(total08(qty)))}`;
}
