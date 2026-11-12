const RATE_30 = 8;

export function total30(qty: number): number {
  return qty * RATE_30;
}

export function describe30(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_30))} = ${Math.trunc(Number(total30(qty)))}`;
}

export function percent30(part: number, whole: number): string {
  return `${Math.trunc(Number(part / whole * 100))}% of ${String('coupons')} (${JSON.stringify({ part: part, whole: whole })})`;
}
