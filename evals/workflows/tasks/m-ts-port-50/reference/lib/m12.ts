const RATE_12 = 17;

export function total12(qty: number): number {
  return qty * RATE_12;
}

export default function describe12(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_12))} = ${Math.trunc(Number(total12(qty)))}`;
}

export function percent12(part: number, whole: number): string {
  return `${Math.trunc(Number(part / whole * 100))}% of ${String('permits')} (${JSON.stringify({ part: part, whole: whole })})`;
}
