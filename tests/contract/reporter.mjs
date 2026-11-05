// Keep complete assertion details in JSONL; the scorecard uses only a one-line reason.
export default async function* reporter(events) {
  const records = [], evidence = new Map();
  for await (const { type, data } of events) {
    if (type === "test:diagnostic" && data.message.startsWith("contract-backend:")) {
      const value = JSON.parse(data.message.slice(17)); evidence.set(value.name, value.backend);
    }
    if (type !== "test:pass" && type !== "test:fail") continue;
    if (data.skip) continue; // --area filters are not out-of-scope cases.
    const match = /^\[([^\]]+)\] (.*?) :: ([\s\S]*)$/.exec(data.name);
    if (!match) {
      if (type === "test:fail") yield `@@CONTRACT_RESULT@@${JSON.stringify({ area: "harness", source: data.file, name: data.name, status: "fail", reason: data.details?.error?.message ?? "Test process failed", backend: "fixture" })}\n`;
      continue;
    }
    const error = data.details?.error;
    const cause = error?.cause ?? error;
    const reason = type === "test:pass" ? "" : String(cause?.message ?? error?.message ?? "Test failed").replace(/\s+/g, " ").trim();
    const row = { area: match[1], source: match[2], name: match[3], status: type === "test:pass" ? "pass" : "fail", durationMs: data.details?.duration_ms, reason, error: error ? { message: error.message, stack: cause?.stack, expected: cause?.expected, actual: cause?.actual, operator: cause?.operator } : undefined };
    records.push({ name: data.name, row });
    yield `${row.status.toUpperCase()} [${row.area}] ${row.name}${reason ? `: ${reason}` : ""}\n`;
  }
  for (const { name, row } of records) yield `@@CONTRACT_RESULT@@${JSON.stringify({ ...row, backend: evidence.get(name) ?? "fixture" })}\n`;
}
