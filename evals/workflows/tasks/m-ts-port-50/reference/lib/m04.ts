const RATE_04 = 18;

export function total04(qty: number): number {
  return qty * RATE_04;
}

export function describe04(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_04))} = ${Math.trunc(Number(total04(qty)))}`;
}
