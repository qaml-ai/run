const RATE_29 = 11;

export function total29(qty: number): number {
  return qty * RATE_29;
}

export function describe29(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_29))} = ${Math.trunc(Number(total29(qty)))}`;
}
