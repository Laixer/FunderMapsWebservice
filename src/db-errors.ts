// Telling "the database is briefly unreachable" apart from "this request
// broke", so a managed-PG failover or maintenance costs a few seconds of 503s
// instead of a process restart.
//
// On 2026-10-08 a failover on db-pg-ams3-0 made DO's PgBouncer answer
// `FATAL 08P01 server login has been failing ... (server_login_retry)` for a
// few seconds. postgres.js delivered that error to the request's query (a
// 500) and to an internal query it never awaits (see `fetch_types` in
// src/db.ts); that second rejection was unhandled and Bun exited the process.
//
// Three things use this module:
//   - src/db.ts turns the driver's un-awaited type lookup off (the cause);
//   - app.onError answers a connectivity error with 503 + Retry-After;
//   - the process-level unhandledRejection guard (src/index.ts) logs a stray
//     connectivity rejection and keeps serving — the pool reconnects on its
//     own — while every other unhandled rejection still exits as before.

import postgres from "postgres";

/** The Retry-After a client gets while the database is unreachable. */
export const DATABASE_RETRY_AFTER_SECONDS = 10;

// SQLSTATEs that mean "the database, or the PgBouncer in front of it, can't
// serve anyone right now" rather than "this query is wrong":
//   08xxx  connection_exception. PgBouncer reports all of its own failures as
//          08P01: server_login_retry (the 2026-10-08 failover),
//          query_wait_timeout, "no more connections allowed", ...
//   57P01  admin_shutdown       — the primary is being stopped (failover)
//   57P02  crash_shutdown
//   57P03  cannot_connect_now   — the node is still starting up
//   53300  too_many_connections
const UNAVAILABLE_SQLSTATE = /^08|^57P0[123]$|^53300$/;

// Errors without a SQLSTATE: postgres.js' own connection errors, and the
// socket/DNS errors Bun surfaces through it.
const UNAVAILABLE_CONNECTION_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

export function isDatabaseUnavailable(err: unknown): boolean {
  if (err instanceof postgres.PostgresError) return UNAVAILABLE_SQLSTATE.test(err.code);
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && UNAVAILABLE_CONNECTION_CODES.has(code);
}

/** One JSON log line per connectivity error, instead of a stack trace per request. */
export function logDatabaseUnavailable(
  source: "request" | "unhandled_rejection",
  err: unknown,
  extra: Record<string, unknown> = {},
) {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  console.error(
    JSON.stringify({
      event: "database_unavailable",
      source,
      ...extra,
      code: e?.code,
      message: String(e?.message ?? err),
    }),
  );
}

/**
 * The process-level `unhandledRejection` listener. Bun's default for an
 * unhandled rejection is to print it and exit 1; that stays the behaviour for
 * everything except a database connectivity error, so real bugs still crash
 * loudly instead of being swallowed.
 */
export function handleUnhandledRejection(
  reason: unknown,
  exit: (code: number) => void = (code) => process.exit(code),
) {
  if (isDatabaseUnavailable(reason)) {
    logDatabaseUnavailable("unhandled_rejection", reason);
    return;
  }
  console.error(reason);
  exit(1);
}
