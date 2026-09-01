import { describe, test, expect, mock, beforeEach } from "bun:test";

// The public readiness check is anonymous, so the properties worth pinning
// are the ones that keep it from becoming a free load generator against the
// database (verdict cache, in-flight dedup, hard timeout) and the HTTP
// contract that consumers' monitors key on (200 { status: "ok" } /
// 503 { code, message }, never cached at the edge, never billed).
//
// db.sql is mocked the same way product.test.ts / mcp.test.ts do it; the
// mock must be installed before health.ts (→ db.ts) is imported.

let sqlCalls: string[] = [];

mock.module("./db.ts", () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ..._values: unknown[]) => {
      sqlCalls.push(strings.join(""));
      return Promise.resolve([{ "?column?": 1 }]);
    },
    { end: async () => {} },
  ),
}));

const { createReadinessCheck } = await import("./health.ts");
const { healthRoutes } = await import("./routes/health.ts");
const { app } = await import("./index.ts");

beforeEach(() => {
  sqlCalls = [];
});

function clock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const up = async () => [];
const down = async () => {
  throw new Error("connection refused");
};

describe("createReadinessCheck", () => {
  test("true when the probe resolves, false when it rejects", async () => {
    expect(await createReadinessCheck({ probe: up })()).toBe(true);
    expect(await createReadinessCheck({ probe: down })()).toBe(false);
  });

  test("a hung probe counts as unavailable once the timeout elapses", async () => {
    const check = createReadinessCheck({
      probe: () => new Promise(() => {}),
      timeoutMs: 20,
    });
    expect(await check()).toBe(false);
  });

  test("verdict is cached: repeated calls inside the window probe once", async () => {
    let calls = 0;
    const c = clock();
    const check = createReadinessCheck({
      probe: async () => void calls++,
      cacheMs: 5_000,
      now: c.now,
    });
    await check();
    await check();
    c.advance(4_999);
    await check();
    expect(calls).toBe(1);
  });

  test("verdict expires: a call after the window probes again", async () => {
    let calls = 0;
    const c = clock();
    const check = createReadinessCheck({
      probe: async () => void calls++,
      cacheMs: 5_000,
      now: c.now,
    });
    await check();
    c.advance(5_000);
    await check();
    expect(calls).toBe(2);
  });

  test("a failed verdict is cached too — a database that is down is not hammered", async () => {
    let calls = 0;
    const c = clock();
    const check = createReadinessCheck({
      probe: async () => {
        calls++;
        throw new Error("down");
      },
      cacheMs: 5_000,
      now: c.now,
    });
    expect(await check()).toBe(false);
    expect(await check()).toBe(false);
    expect(calls).toBe(1);
  });

  test("concurrent callers share one in-flight probe", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const check = createReadinessCheck({
      probe: () => {
        calls++;
        return gate;
      },
    });
    const results = Promise.all([check(), check(), check()]);
    release();
    expect(await results).toEqual([true, true, true]);
    expect(calls).toBe(1);
  });

  test("onChange fires on transitions only — a healthy start is silent", async () => {
    const seen: boolean[] = [];
    let ok = true;
    const c = clock();
    const check = createReadinessCheck({
      probe: async () => {
        if (!ok) throw new Error("down");
      },
      cacheMs: 1,
      now: c.now,
      onChange: (v) => seen.push(v),
    });
    await check(); // healthy start → silent
    c.advance(1);
    await check(); // still healthy → silent
    c.advance(1);
    ok = false;
    await check(); // → unavailable
    c.advance(1);
    await check(); // still unavailable → silent
    c.advance(1);
    ok = true;
    await check(); // → recovered
    expect(seen).toEqual([false, true]);
  });

  test("an unavailable start is logged", async () => {
    const seen: boolean[] = [];
    await createReadinessCheck({ probe: down, onChange: (v) => seen.push(v) })();
    expect(seen).toEqual([false]);
  });
});

describe("healthRoutes", () => {
  test("200 { status: 'ok' } when ready, uncacheable", async () => {
    const res = await healthRoutes(async () => true).request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("503 in the standard { code, message } envelope when not ready", async () => {
    const res = await healthRoutes(async () => false).request("/");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { code: string; message: string };
    expect(Object.keys(body).sort()).toEqual(["code", "message"]);
    expect(body.code).toBe("service_unavailable");
  });
});

describe("GET /v4/health wiring", () => {
  test("/health (liveness) stays dependency-free", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(sqlCalls).toEqual([]);
  });

  test("/v4/health needs no API key, pings the database, and is never tracked", async () => {
    const res = await app.request("/v4/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "ok" });
    expect(sqlCalls).toEqual(["SELECT 1"]);
    expect(sqlCalls.some((q) => q.includes("product_tracker"))).toBe(false);
  });
});
