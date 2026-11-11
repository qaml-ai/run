/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, -1st. */
export function ordinal(n) {
  if (!Number.isInteger(n)) throw new TypeError("n must be an integer");
  const last2 = Math.abs(n) % 100;
  const suffix = last2 >= 11 && last2 <= 13 ? "th" : (["th", "st", "nd", "rd"][last2 % 10] ?? "th");
  return `${n}${suffix}`;
}
