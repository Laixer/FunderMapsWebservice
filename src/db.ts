import postgres from "postgres";
import { env } from "./config.ts";

export const sql = postgres(env.DATABASE_URL, {
  max: 30,
  idle_timeout: 30,
  // Off on purpose. With it on, every new connection first runs a pg_type
  // lookup (for array parsing) that postgres.js starts but never awaits
  // (fetchArrayTypes in connection.js). When PgBouncer fails that lookup —
  // the 2026-10-08 failover — its rejection is unhandled and Bun exits the
  // process. No query here reads or binds a Postgres array; if one ever
  // does, the column comes back as its text form ("{a,b}"), so return
  // to_json(col) instead of turning this back on. See src/db-errors.ts.
  fetch_types: false,
  types: {
    numeric: {
      to: 1700,
      from: [1700],
      serialize: (x: number) => String(x),
      parse: (x: string) => Number(x),
    },
    bigint: {
      to: 20,
      from: [20],
      serialize: (x: number) => String(x),
      parse: (x: string) => Number(x),
    },
  },
});
