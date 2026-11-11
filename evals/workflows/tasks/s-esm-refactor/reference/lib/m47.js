const RATE_47 = 5;

export function total47(qty) {
  return qty * RATE_47;
}

export default function describe47(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_47))} = ${Math.trunc(Number(total47(qty)))}`;
}
