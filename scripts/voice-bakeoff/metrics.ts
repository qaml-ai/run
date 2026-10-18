/**
 * Scoring for the voice bake-off: word error rate (character error rate for languages written without spaces),
 * after normalizing both sides the same way, and latency percentiles.
 */

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** An English number as words (0 to 9,999); longer digit strings digit by digit, as people read them. */
export function numberWords(digits: string): string[] {
  if (digits.length > 4) return [...digits].map(digit => ONES[Number(digit)]);
  const value = Number(digits);
  const below100 = (n: number): string[] => n < 20 ? [ONES[n]] : [TENS[Math.floor(n / 10)], ...(n % 10 ? [ONES[n % 10]] : [])];
  const below1000 = (n: number): string[] => n < 100 ? below100(n) : [ONES[Math.floor(n / 100)], "hundred", ...(n % 100 ? below100(n % 100) : [])];
  if (value < 1000) return below1000(value);
  // Years and the like read as pairs (1984: nineteen eighty four); round thousands as thousands.
  if (value % 1000 === 0) return [ONES[value / 1000], "thousand"];
  if (value >= 1100 && value < 2000 || value >= 2010) return [...below100(Math.floor(value / 100)), ...(value % 100 ? below100(value % 100) : ["hundred"])];
  return [...below100(Math.floor(value / 1000)), "thousand", ...(value % 1000 ? below1000(value % 1000) : [])];
}

/** Hesitations providers transcribe differently (some drop them, some do not): left out on both sides. */
const FILLERS = new Set(["um", "uh", "uhm", "umm", "erm", "er", "hmm", "mm", "ah", "eh"]);

/** Languages scored per character, not per word. */
export const CHARACTER_LANGUAGES = new Set(["ja", "zh", "th", "ko"]);

/**
 * Text as scored: lowercased, accents kept (they matter outside English), punctuation gone, English numbers as words,
 * fillers out, contractions apart where providers differ ("o'clock" stays).
 */
export function normalize(text: string, language = "en"): string[] {
  let value = text.toLowerCase().normalize("NFC")
    .replace(/[’‘`]/g, "'")
    .replace(/(\d),(\d{3})\b/g, "$1$2")
    .replace(/%/g, " percent")
    .replace(/&/g, " and ");
  if (language.startsWith("en")) value = value.replace(/\d+/g, digits => ` ${numberWords(digits).join(" ")} `);
  value = value.replace(/[^\p{L}\p{N}'\s-]/gu, " ").replace(/(^|\s)['-]+|['-]+(?=\s|$)/g, " ").replace(/-/g, " ");
  const words = value.split(/\s+/).filter(word => word && !FILLERS.has(word));
  if (CHARACTER_LANGUAGES.has(language.slice(0, 2))) return [...words.join("")];
  return words;
}

/** Edit distance between two token lists: substitutions, deletions and insertions. */
export function editDistance(reference: string[], hypothesis: string[]) {
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, index) => index);
  for (let i = 1; i <= reference.length; i++) {
    const current = [i];
    for (let j = 1; j <= hypothesis.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[hypothesis.length];
}

/** Errors over the reference's length (WER, or CER for character languages), and the counts it came from. */
export function errorRate(reference: string, hypothesis: string, language = "en") {
  const ref = normalize(reference, language), hyp = normalize(hypothesis, language);
  const errors = editDistance(ref, hyp);
  return { rate: ref.length ? errors / ref.length : hyp.length ? 1 : 0, errors, tokens: ref.length, unit: CHARACTER_LANGUAGES.has(language.slice(0, 2)) ? "char" as const : "word" as const };
}

/** The `p`th percentile (0 to 100) of `values`, by nearest rank; undefined for none. */
export function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))];
}
