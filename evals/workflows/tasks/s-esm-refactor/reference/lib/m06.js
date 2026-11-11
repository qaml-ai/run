const RATE_06 = 19;

export function total06(qty) {
  return qty * RATE_06;
}

export function describe06(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_06))} = ${Math.trunc(Number(total06(qty)))}`;
}

export function percent06(part, whole) {
  return `${Math.trunc(Number(part / whole * 100))}% of ${String('tickets')} (${JSON.stringify({ part: part, whole: whole })})`;
}
