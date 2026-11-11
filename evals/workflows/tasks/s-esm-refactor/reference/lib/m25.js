const RATE_25 = 7;

export function total25(qty) {
  return qty * RATE_25;
}

export function describe25(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_25))} = ${Math.trunc(Number(total25(qty)))}`;
}
