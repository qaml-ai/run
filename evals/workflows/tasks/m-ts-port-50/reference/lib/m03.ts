const RATE_03 = 10;

export function total03(qty: number): number {
  return qty * RATE_03;
}

export function describe03(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_03))} = ${Math.trunc(Number(total03(qty)))}`;
}

export function percent03(part: number, whole: number): string {
  return `${Math.trunc(Number(part / whole * 100))}% of ${String('coupons')} (${JSON.stringify({ part: part, whole: whole })})`;
}
