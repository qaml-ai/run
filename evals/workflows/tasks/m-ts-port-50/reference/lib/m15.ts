const RATE_15 = 9;

export function total15(qty: number): number {
  return qty * RATE_15;
}

export function describe15(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_15))} = ${Math.trunc(Number(total15(qty)))}`;
}

export function percent15(part: number, whole: number): string {
  return `${Math.trunc(Number(part / whole * 100))}% of ${String('vouchers')} (${JSON.stringify({ part: part, whole: whole })})`;
}
