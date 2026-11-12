const RATE_43 = 11;

export function total43(qty: number): number {
  return qty * RATE_43;
}

export function describe43(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_43))} = ${Math.trunc(Number(total43(qty)))}`;
}
