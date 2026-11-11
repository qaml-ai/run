const IRREGULAR: Record<string, string> = { person: "people", child: "children", mouse: "mice", goose: "geese", man: "men", woman: "women", tooth: "teeth", foot: "feet" };
const UNCOUNTABLE = new Set(["sheep", "fish", "series", "species", "information", "equipment", "rice"]);

function matchCase(source: string, target: string): string {
  if (source.length > 1 && source === source.toUpperCase()) return target.toUpperCase();
  if (source[0] === source[0]?.toUpperCase()) return target.charAt(0).toUpperCase() + target.slice(1);
  return target;
}

export function plural(word: string): string {
  const lower = word.toLowerCase();
  if (UNCOUNTABLE.has(lower)) return word;
  const irregular = IRREGULAR[lower];
  if (Object.hasOwn(IRREGULAR, lower) && irregular) return matchCase(word, irregular);
  let result: string;
  if (/[^aeiou]y$/i.test(word)) result = word.slice(0, -1) + "ies";
  else if (/(s|x|z|ch|sh)$/i.test(word)) result = word + "es";
  else if (/fe$/i.test(word)) result = word.slice(0, -2) + "ves";
  else result = word + "s";
  return matchCase(word, result);
}

export function pluralize(word: string, count: number, options: { inclusive?: boolean } = {}): string {
  const form = count === 1 ? word : plural(word);
  return options.inclusive ? `${count} ${form}` : form;
}
