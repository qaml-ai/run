/**
 * Journal reclaim: stage 1 (superseded checkpoints, the default) or, with `--stage host-transcript`, stage 2 (retired host
 * transcripts). Uses the usual AGENT_DATABASE_* operator settings; never loads record content.
 */
import { databaseFromEnvironment } from "../../src/db.ts";
import { reclaimCheckpoints, reclaimHostTranscripts, type ReclaimOptions } from "../../src/pi-durable/reclaim.ts";

const options: ReclaimOptions = {};
let mode: string | undefined, stage = "checkpoints";
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--apply" || arg === "--dry-run") {
    if (mode && mode !== arg) throw new Error("Choose --dry-run or --apply");
    mode = arg; options.apply = arg === "--apply";
  } else if (arg === "--limit") {
    const value = args[++i];
    if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("--limit must be a positive integer");
    options.limit = Number(value);
  } else if (arg === "--session") {
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error("--session requires an ID");
    options.session = value;
  } else if (arg === "--stage") {
    const value = args[++i];
    if (value !== "checkpoints" && value !== "host-transcript") throw new Error("--stage is checkpoints or host-transcript");
    stage = value;
  } else throw new Error(`Unknown option: ${arg}`);
}
const db = await databaseFromEnvironment();
try { console.log(JSON.stringify(await (stage === "host-transcript" ? reclaimHostTranscripts : reclaimCheckpoints)(db, options))); }
finally { await db.end(); }
