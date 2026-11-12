const RATE_17 = 16;

export function total17(qty: number): number {
  return qty * RATE_17;
}

export default function describe17(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_17))} = ${Math.trunc(Number(total17(qty)))}`;
}
