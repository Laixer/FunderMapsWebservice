import { describe, test, expect, afterAll } from "bun:test";

// Regression test for the 2026-10-08 ws-prod crash (see src/db-errors.ts).
//
// During a managed-PG failover DO's PgBouncer logs a client in on its own,
// queues its first query ("No server connection available ..., client being
// queued") and then fails it with FATAL 08P01 "server login has been failing
// ... (server_login_retry)". With postgres.js' default fetch_types that first
// query is the driver's own, un-awaited pg_type lookup: its rejection went
// unhandled and Bun exited the process.
//
// The fake PgBouncer below does exactly that, and the real src/db.ts runs in
// a child process — a fresh module graph, untouched by the db.ts mocks the
// other test files install. The query failing is expected; an unhandled
// rejection (what exited the prod process) is the bug.

function message(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0, "latin1");
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}
const cstr = (s: string) => Buffer.from(`${s}\0`, "utf8");
const int32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const fields = (f: Record<string, string>) =>
  Buffer.concat([...Object.entries(f).map(([k, v]) => Buffer.concat([Buffer.from(k, "latin1"), cstr(v)])), Buffer.from([0])]);

const LOGIN_OK = Buffer.concat([
  message("R", int32(0)), // AuthenticationOk
  message("S", Buffer.concat([cstr("server_version"), cstr("18.0")])),
  message("S", Buffer.concat([cstr("client_encoding"), cstr("UTF8")])),
  message("K", Buffer.concat([int32(1), int32(2)])), // BackendKeyData
  message("Z", Buffer.from("I", "latin1")), // ReadyForQuery
]);
const QUEUED = message("N", fields({
  S: "NOTICE",
  V: "NOTICE",
  C: "00000",
  M: "No server connection available in postgres backend, client being queued",
}));
const LOGIN_FAILING = message("E", fields({
  S: "FATAL",
  V: "FATAL",
  C: "08P01",
  M: "server login has been failing, cached error: connect failed (server_login_retry)",
}));

const bouncer = Bun.listen<{ loggedIn: boolean }>({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    open(s) {
      s.data = { loggedIn: false };
    },
    data(s) {
      if (!s.data.loggedIn) {
        s.data.loggedIn = true;
        s.write(LOGIN_OK);
        return;
      }
      s.write(Buffer.concat([QUEUED, LOGIN_FAILING]));
      s.end();
    },
  },
});

afterAll(() => bouncer.stop(true));

describe("src/db.ts during a PgBouncer login-failure window", () => {
  test("the query fails, the process survives", async () => {
    const dbModule = new URL("./db.ts", import.meta.url).pathname;
    // An unhandled rejection is what exits a `bun run` process (prod), but a
    // child of `bun test` only prints it — so the child fails on one
    // explicitly instead of relying on the runtime default.
    const child = `
      process.on("unhandledRejection", (reason) => {
        console.error("unhandled rejection:", reason?.code, reason?.message);
        process.exit(70);
      });
      const { sql } = await import(${JSON.stringify(dbModule)});
      try {
        await sql\`SELECT 1\`;
        console.log("query succeeded");
      } catch (err) {
        console.log("query rejected: " + (err?.code ?? err?.message));
      }
      // Give a stray rejection time to surface before calling it survived.
      await Bun.sleep(500);
      process.exit(0);
    `;
    const proc = Bun.spawn([process.execPath, "-e", child], {
      env: {
        ...process.env,
        DATABASE_URL: `postgres://ws@127.0.0.1:${bouncer.port}/fundermaps?sslmode=disable`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    // stderr only matters when the child died — it holds the crash.
    expect({ exitCode, stderr: exitCode === 0 ? "" : stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(stdout).toContain("query rejected");
  }, 15_000);
});
