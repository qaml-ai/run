const RATE_22 = 12;

export function total22(qty) {
  return qty * RATE_22;
}

export default function describe22(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_22))} = ${Math.trunc(Number(total22(qty)))}`;
}
