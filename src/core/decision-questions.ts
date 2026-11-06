import { HttpError } from "./http-error.ts";
import { DECISION_LIMITS } from "./limits.ts";

/** Decision questions and their checks (src/decisions.ts re-exports them): channel filters ask one, on either host. */
export type NoulQuestion = { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } };
export type ChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
export type ScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type State = string | Record<string, unknown> | unknown[];

/** The decision models the runtime prices, by OpenRouter id, in USD per million input tokens (output is free). */
export const DECISION_MODELS: Readonly<Record<string, { inputPerMillion: number }>> = Object.freeze({
  "typesafe/jev-1.14": { inputPerMillion: 0.042 },
  "typesafe/jev-1.13": { inputPerMillion: 0.042 },
});
/** The default: a pinned version, never an alias (`~typesafe/jev-latest`), so answers do not shift under thresholds. */
export const DECISION_MODEL = "typesafe/jev-1.14";

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number, what: string) => {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${what} is a non-empty string`);
  if (value.length > max) throw new HttpError(400, `${what} is at most ${max} characters`);
  return value;
};

/** A question as given, checked: its type, instructions and criteria within the limits. `where` names it in errors. */
export function questionInput(value: unknown, id: string, where = `questions.${id}`): Question {
  if (!isRecord(value)) throw new HttpError(400, `${where} is {type, instructions, criteria?}`);
  const extra = Object.keys(value).filter(key => !["type", "instructions", "criteria"].includes(key));
  if (extra.length) throw new HttpError(400, `${where} has unknown fields: ${extra.join(", ")}`);
  const instructions = text(value.instructions, DECISION_LIMITS.instructionChars, `${where}.instructions`);
  const criterion = (entry: unknown, what: string) => text(entry, DECISION_LIMITS.criterionChars, what);
  switch (value.type) {
    case "noul": {
      if (value.criteria === undefined) return { type: "noul", instructions };
      if (!isRecord(value.criteria) || Object.keys(value.criteria).some(key => key !== "true" && key !== "false") || !Object.keys(value.criteria).length) throw new HttpError(400, `${where}.criteria is {true?, false?}: what counts as yes, and as no`);
      const criteria: NoulQuestion["criteria"] = {};
      for (const key of ["true", "false"] as const) if (value.criteria[key] !== undefined) criteria[key] = criterion(value.criteria[key], `${where}.criteria.${key}`);
      return { type: "noul", instructions, criteria };
    }
    case "choice": {
      if (!isRecord(value.criteria)) throw new HttpError(400, `${where}.criteria is {option: description}: the options to choose from`);
      const options = Object.entries(value.criteria);
      if (options.length < 2 || options.length > DECISION_LIMITS.choices) throw new HttpError(400, `${where}.criteria has 2 to ${DECISION_LIMITS.choices} options`);
      const criteria: Record<string, string> = {};
      for (const [name, description] of options) {
        if (!name.trim() || name.length > DECISION_LIMITS.idChars) throw new HttpError(400, `${where}.criteria's option names are 1 to ${DECISION_LIMITS.idChars} characters`);
        // A description may be empty: the option is judged by its name alone.
        criteria[name] = description === "" ? "" : criterion(description, `${where}.criteria.${name}`);
      }
      return { type: "choice", instructions, criteria };
    }
    case "score": {
      if (!Array.isArray(value.criteria) || value.criteria.length < 2 || value.criteria.length > DECISION_LIMITS.levels) throw new HttpError(400, `${where}.criteria is 2 to ${DECISION_LIMITS.levels} levels, lowest first`);
      return { type: "score", instructions, criteria: value.criteria.map((level, index) => criterion(level, `${where}.criteria[${index}]`)) };
    }
    default: throw new HttpError(400, `${where}.type is noul, choice or score`);
  }
}
