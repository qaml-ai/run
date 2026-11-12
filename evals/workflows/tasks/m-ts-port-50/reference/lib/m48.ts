const RATE_48 = 4;

export function total48(qty: number): number {
  return qty * RATE_48;
}

export function describe48(name: unknown, qty: number): string {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_48))} = ${Math.trunc(Number(total48(qty)))}`;
}

export function percent48(part: number, whole: number): string {
  return `${Math.trunc(Number(part / whole * 100))}% of ${String('parcels')} (${JSON.stringify({ part: part, whole: whole })})`;
}
