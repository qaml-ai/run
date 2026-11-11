const RATE_07 = 13;

export function total07(qty) {
  return qty * RATE_07;
}

export default function describe07(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_07))} = ${Math.trunc(Number(total07(qty)))}`;
}
