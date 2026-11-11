const RATE_09 = 8;

export function total09(qty) {
  return qty * RATE_09;
}

export function describe09(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_09))} = ${Math.trunc(Number(total09(qty)))}`;
}

export function percent09(part, whole) {
  return `${Math.trunc(Number(part / whole * 100))}% of ${String('bundles')} (${JSON.stringify({ part: part, whole: whole })})`;
}
