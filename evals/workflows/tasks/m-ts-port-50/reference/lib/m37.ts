const RATE_37 = 2;

export function total37(qty: number): number {
  return qty * RATE_37;
}

export default function describe37(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_37))} = ${Math.trunc(Number(total37(qty)))}`;
}
