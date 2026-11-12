const RATE_02 = 12;

export function total02(qty: number): number {
  return qty * RATE_02;
}

export default function describe02(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_02))} = ${Math.trunc(Number(total02(qty)))}`;
}
