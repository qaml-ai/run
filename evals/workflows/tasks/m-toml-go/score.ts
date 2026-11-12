// Hidden scorer for m-toml-go: build the port's two commands in the judge image (Go 1.27.3, toml-test v2.2.0, no
// network, standard library only) and run toml-test's TOML 1.0 suites. Score: 0.5 valid decoder cases, 0.2 invalid
// ones rejected, 0.3 encoder cases. A port that builds on a third-party TOML library is not a port: it scores 0 and
// is flagged.
import { join } from "node:path";
import { execIn, integrity, judgeImage, read, walk, type Score } from "../../lib/score.ts";
import type { ScoreContext } from "../../lib/types.ts";

/** toml-test v2.2.0's TOML 1.0 case counts, used when a command did not build. */
const TOTALS = { valid: 205, invalid: 474, encoder: 205 };

export async function score({ tree, input, judge, sandbox }: ScoreContext): Promise<Score> {
  if (sandbox !== "docker") throw new Error("m-toml-go's judge runs only in its docker image (Go and toml-test)");
  const check = integrity(input, tree, { tests: [], source: ["go/**/*.go"], protected: ["src/**/*.ts"] });
  const goFiles = walk(tree).filter(file => file.startsWith("go/") && file.endsWith(".go"));
  // Import paths only: single `import "x"` lines and the lines of `import ( … )` blocks, never string literals elsewhere.
  const importsOf = (text: string) => [...text.matchAll(/^import\s+(?:[\w.]+\s+)?"([^"]+)"|^import\s*\(([\s\S]*?)^\)/gm)]
    .flatMap(match => match[1] ? [match[1]] : [...match[2]!.matchAll(/^\s*(?:[\w.]+\s+)?"([^"]+)"/gm)].map(line => line[1]!));
  const imports = new Set(goFiles.flatMap(file => importsOf(read(tree, file) ?? "")));
  const thirdParty = [...imports].filter(path => /^[^/]*\./.test(path));
  const requires = /^\s*require\b/m.test(read(tree, "go/go.mod") ?? "");
  const result = execIn("docker", tree, ["sh", "/judge/run.sh"], { mounts: { "/judge": judge }, image: judgeImage(join(judge, "..", "judge")), timeoutMs: 600_000 });
  const notes: string[] = [];
  const built = { decoder: /^BUILD decoder ok$/m.test(result.stdout), encoder: /^BUILD encoder ok$/m.test(result.stdout) };
  if (!built.decoder || !built.encoder) notes.push(`build failed: ${result.stdout.replace(/REPORT-BEGIN[\s\S]*/, "").slice(0, 1500)}`);
  let report: Record<string, any> = {};
  const json = /REPORT-BEGIN\n([\s\S]*)\nREPORT-END/.exec(result.stdout)?.[1];
  try { report = json ? JSON.parse(json) : {}; } catch { notes.push("toml-test printed no report"); }
  const passed = { valid: Number(report.passed_valid ?? 0), invalid: Number(report.passed_invalid ?? 0), encoder: Number(report.passed_encoder ?? 0) };
  const totals = { valid: Math.max(TOTALS.valid, passed.valid + Number(report.failed_valid ?? 0)), invalid: Math.max(TOTALS.invalid, passed.invalid + Number(report.failed_invalid ?? 0)), encoder: Math.max(TOTALS.encoder, passed.encoder + Number(report.failed_encoder ?? 0)) };
  const wrapped = thirdParty.length > 0 || requires;
  if (wrapped) notes.push(`not a port: ${requires ? "go.mod requires modules" : ""} ${thirdParty.join(", ")}`.trim());
  const failing = (report.tests ?? []).filter((test: { failure?: string }) => test.failure).slice(0, 8).map((test: { path?: string; name?: string }) => test.path ?? test.name);
  if (failing.length) notes.push(`failing: ${failing.join(", ")}`);
  const value = wrapped ? 0 : 0.5 * passed.valid / totals.valid + 0.2 * passed.invalid / totals.invalid + 0.3 * passed.encoder / totals.encoder;
  const all = passed.valid + passed.invalid + passed.encoder, expected = totals.valid + totals.invalid + totals.encoder;
  return { value: Math.round(value * 1000) / 1000, passed: all, failed: expected - all, expected,
    checks: { builtDecoder: built.decoder, builtEncoder: built.encoder, validPassed: passed.valid, invalidPassed: passed.invalid, encoderPassed: passed.encoder, goFiles: goFiles.length, thirdPartyImports: thirdParty.length },
    integrity: { ...check, gamingSuspected: check.gamingSuspected || wrapped }, notes };
}
