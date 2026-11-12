const RATE_24 = 5;

export function total24(qty: number): number {
  return qty * RATE_24;
}

export function describe24(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_24))} = ${Math.trunc(Number(total24(qty)))}`;
}

export function percent24(part: number, whole: number): string {
  return `${Math.trunc(Number(part / whole * 100))}% of ${String('invoices')} (${JSON.stringify({ part: part, whole: whole })})`;
}
