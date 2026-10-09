import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import postgres from "postgres";

// A database blip (managed-PG failover, maintenance) must cost a few 503s,
// never the process (2026-10-08). Pinned here: which errors count as "the
// database is unreachable", the 503 + Retry-After answer the app gives for
// them, and the unhandled-rejection guard that keeps the process alive.
// The end-to-end driver regression lives in src/db.test.ts.
//
// db.sql is mocked the same way health.test.ts / product.test.ts do it; the
// mock must be installed before index.ts (→ db.ts) is imported.

let sqlError: unknown = null;

mock.module("./db.ts", () => ({
  sql: Object.assign(
    (_strings: TemplateStringsArray, ..._values: unknown[]) =>
      sqlError ? Promise.reject(sqlError) : Promise.resolve([]),
    { end: async () => {} },
  ),
}));

const { isDatabaseUnavailable, handleUnhandledRejection, DATABASE_RETRY_AFTER_SECONDS } = await import(
  "./db-errors.ts"
);
const { app } = await import("./index.ts");

const pgError = (code: string, message = "boom") =>
  new postgres.PostgresError({ code, message, severity: "FATAL" } as never);
const withCode = (code: string) => Object.assign(new Error(`write ${code} db:25061`), { code });

// The exact error ws-prod died on.
const LOGIN_FAILING = pgError(
  "08P01",
  "server login has been failing, cached error: connect failed (server_login_retry)",
);

let errorLog: ReturnType<typeof spyOn>;
beforeEach(() => {
  sqlError = null;
  errorLog = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorLog.mockRestore());

describe("isDatabaseUnavailable", () => {
  test("PgBouncer's failover error and the other connection-class SQLSTATEs", () => {
    expect(isDatabaseUnavailable(LOGIN_FAILING)).toBe(true);
    for (const code of ["08000", "08006", "08001", "57P01", "57P02", "57P03", "53300"]) {
      expect(isDatabaseUnavailable(pgError(code))).toBe(true);
    }
  });

  test("a query error is not an outage", () => {
    for (const code of ["42P01", "42703", "22P02", "57014", "23505", "25006"]) {
      expect(isDatabaseUnavailable(pgError(code))).toBe(false);
    }
  });

  test("postgres.js connection errors and socket/DNS errors", () => {
    for (const code of ["CONNECTION_CLOSED", "CONNECTION_DESTROYED", "CONNECTION_ENDED", "CONNECT_TIMEOUT", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND"]) {
      expect(isDatabaseUnavailable(withCode(code))).toBe(true);
    }
  });

  test("anything else is not", () => {
    for (const reason of [new Error("boom"), withCode("UNDEFINED_VALUE"), new TypeError("x is undefined"), "string", null, undefined, 42]) {
      expect(isDatabaseUnavailable(reason)).toBe(false);
    }
  });
});

describe("handleUnhandledRejection", () => {
  test("a connectivity rejection is logged as one JSON line and the process lives", () => {
    const exit = mock((_code: number) => {});
    handleUnhandledRejection(LOGIN_FAILING, exit);
    expect(exit).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(JSON.parse(errorLog.mock.calls[0]![0] as string)).toEqual({
      event: "database_unavailable",
      source: "unhandled_rejection",
      code: "08P01",
      message: "server login has been failing, cached error: connect failed (server_login_retry)",
    });
  });

  test("any other rejection keeps Bun's default: print it, exit 1", () => {
    const exit = mock((_code: number) => {});
    const bug = new TypeError("cannot read properties of undefined");
    handleUnhandledRejection(bug, exit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorLog).toHaveBeenCalledWith(bug);
  });
});

describe("app.onError", () => {
  // Each test uses its own key: resolveKey caches a successful lookup for
  // 60 s, and a failed one must not be cached at all.
  const productCall = (key: string) =>
    app.request("/v4/product/light/NL.IMBAG.PAND.0141100000032921", {
      headers: { Authorization: `Bearer fmsk.${key}` },
    });

  test("database unreachable → 503 service_unavailable with Retry-After", async () => {
    sqlError = LOGIN_FAILING;
    const res = await productCall("db-errors-503");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe(String(DATABASE_RETRY_AFTER_SECONDS));
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("service_unavailable");
    expect(body.message).toContain(`${DATABASE_RETRY_AFTER_SECONDS} seconds`);
  });

  test("the 503 is logged as one database_unavailable line, not a stack trace", async () => {
    sqlError = withCode("CONNECTION_CLOSED");
    await productCall("db-errors-log");
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(JSON.parse(errorLog.mock.calls[0]![0] as string)).toMatchObject({
      event: "database_unavailable",
      source: "request",
      method: "GET",
      path: "/v4/product/light/NL.IMBAG.PAND.0141100000032921",
      code: "CONNECTION_CLOSED",
    });
  });

  test("a query error is still a 500 internal_server_error", async () => {
    sqlError = pgError("42P01", 'relation "application.auth_key" does not exist');
    const res = await productCall("db-errors-500");
    expect(res.status).toBe(500);
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(((await res.json()) as { code: string }).code).toBe("internal_server_error");
  });

  test("once the database is back, the same key is served normally", async () => {
    sqlError = LOGIN_FAILING;
    expect((await productCall("db-errors-recover")).status).toBe(503);
    sqlError = null;
    // The mock returns no rows: the key is unknown, which is the point —
    // the outage left nothing cached and the request reached the DB again.
    expect((await productCall("db-errors-recover")).status).toBe(401);
  });
});
