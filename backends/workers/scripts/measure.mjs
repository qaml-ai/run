import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";
const root = fileURLToPath(new URL("../../../", import.meta.url));
async function files(dir) {
  const result = [];
  for (const item of await readdir(path.join(root, dir), {
    withFileTypes: true,
  })) {
    if (item.name.startsWith(".") || item.name === "node_modules") continue;
    const file = `${dir}/${item.name}`;
    if (item.isDirectory()) result.push(...(await files(file)));
    else if (file.endsWith(".ts") && !file.endsWith(".d.ts")) result.push(file);
  }
  return result.sort();
}
const excluded = {
  test(file) {
    if (/^src\/voice-providers\/(tts|tts-chain|prices)\.ts$/.test(file)) return false;
    return /^src\/(?:channels|channel-filter|discord-managed|voice|opus)/.test(file);
  },
};
function category(file) {
  const name = file.replace(/^backends\/workers\//, "").replace(/^src\//, "");
  if (/^(?:codemode\/|codemode|v8-exec|sandbox)/.test(name))
    return "Code execution";
  if (
    /^(?:ownership|node(?:[.-]|$)|server|supervisor|agent-child|rpc|process-memory|memory-retirement|ecs|busy-agents|rate-limits|tenant)/.test(
      name,
    )
  )
    return "Hosting, admission, tenancy";
  if (
    /^(?:account|admin|billing|credit|end-user|model-attempt|usage|webhook|control|postgres|db|email|console-auth|password|oauth|journey|card-credit|stripe|auto-topup|key-check|key-scopes|credential)/.test(
      name,
    )
  )
    return "Accounts, money, webhooks";
  if (
    /^(?:image|media|speech|transcription|audio-header|voice-providers\/(?:tts|prices)|request-images|file|volume|storage|gc-|pin-|tar|zip|parse-job|inspect|computers\/|computer-|tool-files)/.test(
      name,
    )
  )
    return "Files, images, computers";
  if (
    /^(?:agent(?:\.|-host|-mcp)|pi-|client-sessions|history|human|input|scheduler|schedule|workflow|multi-agent|model\.)/.test(
      name,
    )
  )
    return "Agents, history, schedules";
  return "HTTP, contracts, remaining policy";
}
const source = (await files("src")).filter((x) => !excluded.test(x));
const worker = new Set([
  ...(await files("backends/workers/src")),
  ...(await files("backends/workers/codemode")),
]);
// Count unchanged portable source imported at runtime too. Generated policy
// copies already count at their Workers paths; type-only imports add no code.
for (const file of worker) {
  const text = await readFile(path.join(root,file),'utf8');
  for (const match of text.matchAll(/import\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["']/g)) {
    if (!match[1].startsWith('.')) continue;
    const dependency = path.relative(root,path.resolve(root,path.dirname(file),match[1]));
    if (dependency.startsWith('src/') && dependency.endsWith('.ts')) worker.add(dependency);
  }
}
const records = [];
for (const [backend, all] of [
  ["ecs", source],
  ["workers", [...worker]],
])
  for (const file of all) {
    const text = await readFile(path.join(root, file), "utf8");
    records.push({
      backend,
      area: category(file),
      file,
      lines: text.split("\n").length - Number(text.endsWith("\n")),
      nonblank: text.split("\n").filter((x) => x.trim()).length,
    });
  }
const areas = [...new Set(records.map((x) => x.area))];
const rows = areas.map((area) => {
  const side = (backend) => {
    const r = records.filter((x) => x.area === area && x.backend === backend);
    return {
      files: r.length,
      lines: r.reduce((n, x) => n + x.lines, 0),
      nonblank: r.reduce((n, x) => n + x.nonblank, 0),
    };
  };
  return { area, ecs: side("ecs"), workers: side("workers") };
});
const report = {
  runtimeNonTypeScript: [
    {
      file: "backends/workers/computers/parse.mjs",
      lines: (
        await readFile(
          path.join(root, "backends/workers/computers/parse.mjs"),
          "utf8",
        )
      )
        .trimEnd()
        .split("\n").length,
    },
  ],
  // Sprite validation uses a committed git archive, which has no .git directory.
  sourceCommit: process.env.WORKERS_MEASURE_COMMIT ?? execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  worktreeDirty: process.env.WORKERS_MEASURE_COMMIT ? false : execFileSync("git", ["status", "--porcelain"], {cwd:root,encoding:"utf8"}).trim().length > 0,
  method:
    "Physical TypeScript lines, comments and blanks included; declarations, tests, dependencies and generated bindings excluded. Whole mixed-purpose source files counted. Not feature-equivalent.",
  excluded: (await files("src")).filter((x) => excluded.test(x)),
  rows,
  records,
};
await writeFile(
  new URL("../measurements/code-size.json", import.meta.url),
  JSON.stringify(report, null, 2) + "\n",
);
console.log("| Area | ECS lines / files | Workers lines / files |");
console.log("| --- | ---: | ---: |");
for (const r of rows)
  console.log(
    `| ${r.area} | ${r.ecs.lines.toLocaleString("en-US")} / ${r.ecs.files} | ${r.workers.lines.toLocaleString("en-US")} / ${r.workers.files} |`,
  );
const total = (backend) =>
  records
    .filter((x) => x.backend === backend)
    .reduce((a, x) => ({ lines: a.lines + x.lines, files: a.files + 1 }), {
      lines: 0,
      files: 0,
    });
console.log(
  `| Total | ${total("ecs").lines.toLocaleString("en-US")} / ${total("ecs").files} | ${total("workers").lines.toLocaleString("en-US")} / ${total("workers").files} |`,
);
