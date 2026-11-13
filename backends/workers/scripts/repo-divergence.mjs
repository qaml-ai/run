// TEMPORARY(node-backend): a bridge until the Node backend retires; then the generators and this file go.
// Workers has no Volumes (camel-fs-files.md): a few generated copies of src/ intentionally differ from Node's
// where Node still speaks volumes (mounts, file refs, file grants). The differences are data in
// repo-divergence.json, applied to the generated text; a `from` that no longer occurs in the generated text is
// an error, so a change in src/ to the diverged lines still fails check:reuse instead of being silently kept.
import { readFileSync } from "node:fs";

const pairs = JSON.parse(readFileSync(new URL("./repo-divergence.json", import.meta.url), "utf8"));
export function diverge(name, text) {
  for (const [from, to] of pairs[name] ?? []) {
    if (!text.includes(from)) throw new Error(`${name}: the repos divergence no longer applies; src/ changed near: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, to);
  }
  return text;
}
