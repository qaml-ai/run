const RATE_18 = 11;

export function total18(qty) {
  return qty * RATE_18;
}

export function describe18(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_18))} = ${Math.trunc(Number(total18(qty)))}`;
}

export function percent18(part, whole) {
  return `${Math.trunc(Number(part / whole * 100))}% of ${String('coupons')} (${JSON.stringify({ part: part, whole: whole })})`;
}
