const RATE_06 = 19;

export function total06(qty: number): number {
  return qty * RATE_06;
}

export function describe06(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_06))} = ${Math.trunc(Number(total06(qty)))}`;
}

export function percent06(part: number, whole: number): string {
  return `${Math.trunc(Number(part / whole * 100))}% of ${String('tickets')} (${JSON.stringify({ part: part, whole: whole })})`;
}
