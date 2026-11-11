const RATE_39 = 17;

export function total39(qty) {
  return qty * RATE_39;
}

export function describe39(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_39))} = ${Math.trunc(Number(total39(qty)))}`;
}

export function percent39(part, whole) {
  return `${Math.trunc(Number(part / whole * 100))}% of ${String('vouchers')} (${JSON.stringify({ part: part, whole: whole })})`;
}
