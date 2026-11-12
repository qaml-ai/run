const RATE_27 = 19;

export function total27(qty: number): number {
  return qty * RATE_27;
}

export default function describe27(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_27))} = ${Math.trunc(Number(total27(qty)))}`;
}

export function percent27(part: number, whole: number): string {
  return `${Math.trunc(Number(part / whole * 100))}% of ${String('pallets')} (${JSON.stringify({ part: part, whole: whole })})`;
}
