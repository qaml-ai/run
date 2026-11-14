// Keep admissions in one UTC minute using the same clock as the fixture's tier verifier.
import { PROMPT_ADMISSION_TIME } from "./prompt-admission-time.ts";

Date.now = () => PROMPT_ADMISSION_TIME;

export * from "../src/index.ts";
export { default } from "../src/index.ts";
