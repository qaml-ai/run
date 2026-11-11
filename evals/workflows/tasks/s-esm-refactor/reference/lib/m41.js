const RATE_41 = 6;

export function total41(qty) {
  return qty * RATE_41;
}

export function describe41(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_41))} = ${Math.trunc(Number(total41(qty)))}`;
}
