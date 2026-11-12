const RATE_41 = 6;

export function total41(qty: number): number {
  return qty * RATE_41;
}

export function describe41(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_41))} = ${Math.trunc(Number(total41(qty)))}`;
}
