import { randomUUID } from "node:crypto";
import pg from "pg";

// Node preloads this in each test process. Separate databases keep database-wide migration locks
// from serializing otherwise independent schemas. The CI job discards the whole Postgres instance.
const url = new URL(process.env.AGENT_TEST_DATABASE_URL!);
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Test databases must be local");
url.pathname = "/postgres";
const admin = new pg.Client({ connectionString: url.toString() });
await admin.connect();
const database = `worker_${randomUUID().replaceAll("-", "")}`;
try { await admin.query(`create database ${database}`); }
finally { await admin.end(); }
url.pathname = `/${database}`;
process.env.AGENT_TEST_DATABASE_URL = url.toString();
