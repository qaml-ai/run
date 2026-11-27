import {
  AssistantEntry,
  CompactionEntry,
  ResetEntry,
  ROOT_CONVERSATION_ID,
  SystemEntry,
  ToolResultEntry,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import {
  CamelRunUserEntry,
  mapPiHistoryCompaction,
  mapPiHistoryMessage,
  type MappedHistoryResult,
} from "./migrate.ts";

function entryConditions(record: string) {
  const kind = `json_extract(${record}, '$.kind')`;
  const role = `json_extract(${record}, '$.model[0].role')`;
  const markerKinds = `'${CompactionEntry.kind}', '${ResetEntry.kind}'`;
  const marker = `${kind} IN (${markerKinds})`;
  const user = `(${role} = 'user' AND ${kind} NOT IN ('${SystemEntry.kind}', ${markerKinds}))`;
  const response = `((${kind} = '${AssistantEntry.kind}' AND ${role} = 'assistant')
                  OR (${kind} = '${ToolResultEntry.kind}' AND ${role} = 'toolResult'))`;
  return { kind, marker, user, response };
}

const entries = entryConditions("record");
const isHistoryMessage = `(${entries.user} OR ${entries.response})`;
const isRunBoundary = `(${entries.user} OR ${entries.marker})`;

/**
 * Pi 1.6 stores the root transcript in pi_entries (id, conversation_id, head,
 * commit_seq, record). Its (conversation_id, id) index supports cursor seeks.
 * These partial indexes also skip non-messages and find run/compaction markers
 * without reading arbitrarily long gaps. SQLite builds them once per existing DO.
 */
export function ensurePiHistoryIndexes(sql: SqlStorage): void {
  sql.exec(`
    CREATE INDEX IF NOT EXISTS camelrun_history_messages
      ON pi_entries (conversation_id, id) WHERE ${isHistoryMessage};
    CREATE INDEX IF NOT EXISTS camelrun_history_run_boundaries
      ON pi_entries (conversation_id, id) WHERE ${isRunBoundary};
    CREATE INDEX IF NOT EXISTS camelrun_history_compactions
      ON pi_entries (conversation_id, id) WHERE ${entries.marker};
  `);
}

interface PiHistoryOptions {
  after?: number;
  before?: number;
  limit?: number;
}

export function readPiHistoryPage(
  sql: Pick<SqlStorage, "exec">,
  opts?: PiHistoryOptions,
): MappedHistoryResult {
  const after = Math.max(0, Number(opts?.after ?? 0));
  const before = opts?.before;
  const newest = before !== undefined;
  const cursor = newest ? Number(before) : after;
  const clampedLimit = Math.floor(Math.max(1, Math.min(500, Number(opts?.limit ?? 50))));
  // The old backward slice treated NaN as 0 and returned every matching row.
  const limit = Number.isNaN(clampedLimit) ? (newest ? 50 : 0) : clampedLimit;
  const ids = limit > 0 && !Number.isNaN(cursor)
    ? sql.exec<{ id: number }>(
        `SELECT id FROM pi_entries INDEXED BY camelrun_history_messages
         WHERE conversation_id = ? AND ${isHistoryMessage} AND id ${newest ? "<" : ">"} ?
         ORDER BY id ${newest ? "DESC" : "ASC"} LIMIT ?`,
        ROOT_CONVERSATION_ID,
        Math.max(0, Math.min(Number.MAX_SAFE_INTEGER + 1, cursor)),
        limit + (newest ? 1 : 0),
      ).toArray()
    : [];
  const hasOlder = ids.length > limit;
  if (hasOlder) ids.pop();

  const page = entryConditions("entry.record");
  const prior = entryConditions("prior.record");
  const messages: MappedHistoryResult["messages"] = [];
  if (ids.length > 0) {
    const rows = sql.exec<{
        record: string;
        run_id: string | null;
        meta_json: string | null;
        inherited_run_id: string | null;
      }>(
        `SELECT entry.record, meta.run_id, meta.meta_json,
           CASE WHEN meta.run_id IS NULL AND ${page.response} THEN (
             SELECT CASE
               WHEN ${prior.kind} = '${CamelRunUserEntry.kind}'
                 AND json_type(prior.record, '$.data.runId') IS NOT NULL
               THEN json_extract(prior.record, '$.data.runId')
               WHEN ${prior.user}
               THEN (SELECT run_id FROM pi_entry_meta WHERE entry_id = prior.id)
             END
             FROM pi_entries AS prior INDEXED BY camelrun_history_run_boundaries
             WHERE prior.conversation_id = entry.conversation_id AND prior.id < entry.id
               AND (${prior.user} OR ${prior.marker})
             ORDER BY prior.id DESC LIMIT 1
           ) END AS inherited_run_id
         FROM pi_entries AS entry
         LEFT JOIN pi_entry_meta AS meta ON meta.entry_id = entry.id
         WHERE entry.id IN (SELECT value FROM json_each(?))
         ORDER BY entry.id ASC`,
        JSON.stringify(ids.map(({ id }) => id)),
      );
    for (const { record, run_id, meta_json, inherited_run_id } of rows) {
      const message = mapPiHistoryMessage(
        JSON.parse(record) as EntryRecord,
        { runId: run_id, ...(meta_json ? { meta: JSON.parse(meta_json) as Record<string, unknown> } : {}) },
        inherited_run_id,
      );
      if (message) messages.push(message);
    }
  }

  // The response describes the latest compaction/reset of the whole
  // conversation, even when the selected messages precede it.
  const marker = sql.exec<{ record: string }>(
    `SELECT record FROM pi_entries INDEXED BY camelrun_history_compactions
     WHERE conversation_id = ? AND ${entries.marker}
     ORDER BY id DESC LIMIT 1`,
    ROOT_CONVERSATION_ID,
  ).toArray()[0];
  return {
    messages,
    compaction: marker ? mapPiHistoryCompaction(JSON.parse(marker.record) as EntryRecord) : null,
    nextAfter: messages.at(-1)?.seq ?? after,
    ...(newest ? { nextBefore: hasOlder ? messages[0]!.seq : null } : {}),
  };
}
