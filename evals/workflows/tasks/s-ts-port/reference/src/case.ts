import { splitWords } from "./words.ts";

const lower = (word: string) => word.toLowerCase();
const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

export const camelCase = (input: string): string => splitWords(input).map((word, index) => (index ? capital(word) : lower(word))).join("");
export const pascalCase = (input: string): string => splitWords(input).map(capital).join("");
export const snakeCase = (input: string): string => splitWords(input).map(lower).join("_");
export const kebabCase = (input: string): string => splitWords(input).map(lower).join("-");
export const constantCase = (input: string): string => splitWords(input).map((word) => word.toUpperCase()).join("_");
