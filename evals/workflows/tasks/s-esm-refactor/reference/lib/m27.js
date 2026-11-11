const RATE_27 = 19;

export function total27(qty) {
  return qty * RATE_27;
}

export default function describe27(name, qty) {
  return `${String(name)} x${Math.trunc(Number(qty))} @ ${Math.trunc(Number(RATE_27))} = ${Math.trunc(Number(total27(qty)))}`;
}

export function percent27(part, whole) {
  return `${Math.trunc(Number(part / whole * 100))}% of ${String('pallets')} (${JSON.stringify({ part: part, whole: whole })})`;
}
