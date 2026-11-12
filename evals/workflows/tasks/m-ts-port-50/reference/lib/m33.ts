const RATE_33 = 4;

export function total33(qty: number): number {
  return qty * RATE_33;
}

export function describe33(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_33))} = ${Math.trunc(Number(total33(qty)))}`;
}

export function percent33(part: number, whole: number): string {
  return `${Math.trunc(Number(part / whole * 100))}% of ${String('vouchers')} (${JSON.stringify({ part: part, whole: whole })})`;
}
