import { splitWords } from "./words.js";

const lower = (word) => word.toLowerCase();
const capital = (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

export const camelCase = (input) => splitWords(input).map((word, index) => (index ? capital(word) : lower(word))).join("");
export const pascalCase = (input) => splitWords(input).map(capital).join("");
export const snakeCase = (input) => splitWords(input).map(lower).join("_");
export const kebabCase = (input) => splitWords(input).map(lower).join("-");
export const constantCase = (input) => splitWords(input).map((word) => word.toUpperCase()).join("_");
