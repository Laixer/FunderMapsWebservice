import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Hono } from "hono";

// The stamp reads one row (default model slug + last ok refresh). db.sql is
// mocked the same way the other suites do it.
let queryQueue: unknown[][] = [];
let fail = false;
let calls = 0;

mock.module("./db.ts", () => ({
  sql: (_strings: TemplateStringsArray, ..._values: unknown[]) => {
    calls++;
    if (fail) return Promise.reject(new Error("db down"));
    return Promise.resolve(queryQueue.length > 0 ? queryQueue.shift() : []);
  },
}));

const { currentVersion, resetVersionCache, versionMiddleware, VERSION_HEADER } = await import("./version.ts");

const ROW = [{ slug: "model-2024.1", at: new Date("2026-10-06T19:59:49.855Z") }];

beforeEach(() => {
  queryQueue = [];
  fail = false;
  calls = 0;
  resetVersionCache();
});

function app() {
  const a = new Hono();
  a.use("*", versionMiddleware);
  a.get("/obj", (c) => c.json({ buildingId: "NL.IMBAG.PAND.1", drystandRisk: "c" }));
  a.get("/arr", (c) => c.json([1, 2]));
  a.get("/missing", (c) => c.json({ code: "no_data_available" }, 404));
  return a;
}

describe("currentVersion", () => {
  test("model slug + ISO time of the last ok refresh", async () => {
    queryQueue = [ROW];
    expect(await currentVersion()).toEqual({ modelVersion: "model-2024.1", calculatedAt: "2026-10-06T19:59:49.855Z" });
  });

  test("read once per minute, not per request", async () => {
    queryQueue = [ROW, ROW];
    await currentVersion(1_000);
    await currentVersion(30_000);
    expect(calls).toBe(1);
    await currentVersion(62_000);
    expect(calls).toBe(2);
  });

  test("no refresh or no default model → no stamp", async () => {
    queryQueue = [[{ slug: "model-2024.1", at: null }]];
    expect(await currentVersion()).toBeNull();
  });

  test("a failed lookup keeps the last good value", async () => {
    queryQueue = [ROW];
    await currentVersion(1_000);
    fail = true;
    expect(await currentVersion(70_000)).toEqual({ modelVersion: "model-2024.1", calculatedAt: "2026-10-06T19:59:49.855Z" });
  });
});

describe("versionMiddleware", () => {
  test("200 JSON object: header and both body fields, original fields intact", async () => {
    queryQueue = [ROW];
    const res = await app().request("/obj");
    expect(res.status).toBe(200);
    expect(res.headers.get(VERSION_HEADER)).toBe("model-2024.1@2026-10-06T19:59:49.855Z");
    expect(await res.json()).toEqual({
      buildingId: "NL.IMBAG.PAND.1",
      drystandRisk: "c",
      modelVersion: "model-2024.1",
      calculatedAt: "2026-10-06T19:59:49.855Z",
    });
  });

  test("error body: header only, body untouched", async () => {
    queryQueue = [ROW];
    const res = await app().request("/missing");
    expect(res.status).toBe(404);
    expect(res.headers.get(VERSION_HEADER)).toBe("model-2024.1@2026-10-06T19:59:49.855Z");
    expect(await res.json()).toEqual({ code: "no_data_available" });
  });

  test("an array body is left alone", async () => {
    queryQueue = [ROW];
    const res = await app().request("/arr");
    expect(await res.json()).toEqual([1, 2]);
  });

  test("lookup down from the start: the delivery still goes out, unstamped", async () => {
    fail = true;
    const res = await app().request("/obj");
    expect(res.status).toBe(200);
    expect(res.headers.get(VERSION_HEADER)).toBeNull();
    expect(await res.json()).toEqual({ buildingId: "NL.IMBAG.PAND.1", drystandRisk: "c" });
  });
});
