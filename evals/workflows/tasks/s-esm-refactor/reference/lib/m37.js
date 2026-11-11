const RATE_37 = 2;

export function total37(qty) {
  return qty * RATE_37;
}

export default function describe37(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_37))} = ${Math.trunc(Number(total37(qty)))}`;
}
