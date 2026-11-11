const RATE_05 = 18;

export function total05(qty) {
  return qty * RATE_05;
}

export function describe05(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_05))} = ${Math.trunc(Number(total05(qty)))}`;
}
