const RATE_47 = 5;

export function total47(qty: number): number {
  return qty * RATE_47;
}

export default function describe47(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_47))} = ${Math.trunc(Number(total47(qty)))}`;
}
