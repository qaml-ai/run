import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { TestContext } from "node:test";

export function repoSqliteStorage(t: TestContext) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  let alarm: number | null = null;
  let alarmWrites = 0;
  const storage = {
    sql: { exec(query: string, ...args: SQLInputValue[]) {
      const stmt = db.prepare(query);
      const rows = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []);
      return {
        toArray: () => rows,
        one: () => { assert.equal(rows.length, 1); return rows[0]; },
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    } },
    transactionSync<T>(fn: () => T) {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    setAlarm: async (next: number) => { alarmWrites++; alarm = next; },
    getAlarm: async () => alarm,
    deleteAlarm: async () => { alarmWrites++; alarm = null; },
    deleteAll: async () => {
      alarm = null;
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
        db.exec(`DROP TABLE "${name}"`);
      }
    },
  };
  return { storage, alarmWrites: () => alarmWrites };
}
