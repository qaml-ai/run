const IRREGULAR = { person: "people", child: "children", mouse: "mice", goose: "geese", man: "men", woman: "women", tooth: "teeth", foot: "feet" };
const UNCOUNTABLE = new Set(["sheep", "fish", "series", "species", "information", "equipment", "rice"]);

function matchCase(source, target) {
  if (source.length > 1 && source === source.toUpperCase()) return target.toUpperCase();
  if (source[0] === source[0].toUpperCase()) return target[0].toUpperCase() + target.slice(1);
  return target;
}

/** The English plural of a noun, keeping its case (Person -> People, BOX -> BOXES). */
export function plural(word) {
  const lower = word.toLowerCase();
  if (UNCOUNTABLE.has(lower)) return word;
  if (Object.hasOwn(IRREGULAR, lower)) return matchCase(word, IRREGULAR[lower]);
  let result;
  if (/[^aeiou]y$/i.test(word)) result = word.slice(0, -1) + "ies";
  else if (/(s|x|z|ch|sh)$/i.test(word)) result = word + "es";
  else if (/fe$/i.test(word)) result = word.slice(0, -2) + "ves";
  else result = word + "s";
  return matchCase(word, result);
}

/** The form for `count` items; `inclusive` puts the count in front ("3 boxes"). */
export function pluralize(word, count, options = {}) {
  const form = count === 1 ? word : plural(word);
  return options.inclusive ? `${count} ${form}` : form;
}
