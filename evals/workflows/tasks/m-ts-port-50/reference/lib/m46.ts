const RATE_46 = 16;

export function total46(qty: number): number {
  return qty * RATE_46;
}

export function describe46(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_46))} = ${Math.trunc(Number(total46(qty)))}`;
}
