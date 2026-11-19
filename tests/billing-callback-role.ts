import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";

export async function callbackRole(db: Pool, url: string) {
  const role = `callback_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();
  const grants = readFileSync(new URL("../deploy/v1-billing-callbacks/grants.sql", import.meta.url), "utf8");
  const release = async () => {
    await db.query(`drop owned by ${role}`);
    await db.query(`drop role ${role}`);
  };
  await db.query(`create role ${role} login password '${password}'`);
  try {
    await db.query(grants.replaceAll(':"callback_role"', role));
  } catch (error) {
    await release();
    throw error;
  }
  const restricted = new URL(url);
  restricted.username = role;
  restricted.password = password;
  return { url: restricted.toString(), release };
}
