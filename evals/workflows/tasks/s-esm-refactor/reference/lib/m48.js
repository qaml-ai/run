const RATE_48 = 4;

export function total48(qty) {
  return qty * RATE_48;
}

export function describe48(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_48))} = ${Math.trunc(Number(total48(qty)))}`;
}

export function percent48(part, whole) {
  return `${Math.trunc(Number(part / whole * 100))}% of ${String('parcels')} (${JSON.stringify({ part: part, whole: whole })})`;
}
