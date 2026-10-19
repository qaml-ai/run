import { randomUUID } from "node:crypto";
import pg from "pg";

// Node preloads this in each test process. Separate databases keep database-wide migration locks
// from serializing otherwise independent schemas. Each worker also owns its role, whose settings
// migrations update. The CI job discards the whole Postgres instance.
if (process.argv[1]?.endsWith(".test.ts")) {
  const url = new URL(process.env.AGENT_TEST_DATABASE_URL!);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Test databases must be local");
  url.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  const database = `worker_${randomUUID().replaceAll("-", "")}`;
  try {
    await admin.query(`create role ${database} login superuser password 'test'`);
    await admin.query(`create database ${database} owner ${database}`);
  } finally { await admin.end(); }
  url.pathname = `/${database}`;
  url.username = database;
  url.password = "test";
  process.env.AGENT_TEST_DATABASE_URL = url.toString();
}
