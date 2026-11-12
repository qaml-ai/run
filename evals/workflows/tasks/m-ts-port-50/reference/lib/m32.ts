const RATE_32 = 10;

export function total32(qty: number): number {
  return qty * RATE_32;
}

export default function describe32(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_32))} = ${Math.trunc(Number(total32(qty)))}`;
}
