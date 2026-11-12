const RATE_09 = 8;

export function total09(qty: number): number {
  return qty * RATE_09;
}

export function describe09(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_09))} = ${Math.trunc(Number(total09(qty)))}`;
}

export function percent09(part: number, whole: number): string {
  return `${Math.trunc(Number(part / whole * 100))}% of ${String('bundles')} (${JSON.stringify({ part: part, whole: whole })})`;
}
