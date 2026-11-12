const RATE_22 = 12;

export function total22(qty: number): number {
  return qty * RATE_22;
}

export default function describe22(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_22))} = ${Math.trunc(Number(total22(qty)))}`;
}
