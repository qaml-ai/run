const RATE_36 = 5;

export function total36(qty: number): number {
  return qty * RATE_36;
}

export function describe36(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_36))} = ${Math.trunc(Number(total36(qty)))}`;
}

export function percent36(part: number, whole: number): string {
  return `${Math.trunc(Number(part / whole * 100))}% of ${String('widgets')} (${JSON.stringify({ part: part, whole: whole })})`;
}
