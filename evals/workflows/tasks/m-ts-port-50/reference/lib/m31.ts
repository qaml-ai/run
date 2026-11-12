const RATE_31 = 10;

export function total31(qty: number): number {
  return qty * RATE_31;
}

export function describe31(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_31))} = ${Math.trunc(Number(total31(qty)))}`;
}
