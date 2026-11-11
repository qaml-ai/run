const RATE_17 = 16;

export function total17(qty) {
  return qty * RATE_17;
}

export default function describe17(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_17))} = ${Math.trunc(Number(total17(qty)))}`;
}
