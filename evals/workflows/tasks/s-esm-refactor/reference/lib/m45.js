const RATE_45 = 15;

export function total45(qty) {
  return qty * RATE_45;
}

export function describe45(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_45))} = ${Math.trunc(Number(total45(qty)))}`;
}

export function percent45(part, whole) {
  return `${Math.trunc(Number(part / whole * 100))}% of ${String('coupons')} (${JSON.stringify({ part: part, whole: whole })})`;
}
