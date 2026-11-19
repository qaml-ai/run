// Report each failed runtime assertion once per process.
const failed = new Set<string>();

export function always(condition: boolean, message: string) {
  if (condition || failed.has(message)) return;
  failed.add(message);
  console.error(JSON.stringify({ type: "assert", kind: "always", assertion: message }));
}
