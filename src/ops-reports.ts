import { adminTrend } from "./admin-signals.ts";
import { LIVE, count } from "./core/ops-reports.ts";
import { transaction, type Db, type Sql } from "./db.ts";

// The queries are one copy in src/core/ops-reports.ts; only the host's own two stay here.
export * from "./core/ops-reports.ts";

/** Sign-ups and returning active accounts by UTC day (adminTrend), the same as the admin site's chart. */
export async function trend(db: Sql, options: { days: number; now?: number }) {
  const result = await adminTrend(db, { days: options.days, ...(options.now !== undefined ? { now: options.now } : {}) });
  return {
    rows: result.daily.map(day => ({ day: day.date, signups: day.signups, returning_active: day.returning_active })),
    incomplete_day: result.incomplete_date,
  };
}

/** Whether the database answers, how long it took, and the platform's size: tenants, live agents, ops grants. */
export async function health(db: Db) {
  const started = Date.now();
  const size = await transaction(db, async sql => {
    await sql.query("set transaction isolation level repeatable read, read only");
    return sql.query(`select
      (select count(*) from tenants t where ${LIVE}) as tenants,
      (select count(*) from agents where not revoked) as agents,
      (select count(*) from oauth_grants where resource = 'ops') as ops_grants`);
  });
  return {
    rows: [{
      check: "database", ok: true, ms: Date.now() - started,
      tenants: count(size.rows[0]?.tenants), agents: count(size.rows[0]?.agents), ops_grants: count(size.rows[0]?.ops_grants),
    }],
  };
}
