import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { clampId, errorJson, ERROR_CODES } from "./errors.ts";

// The error contract is consumer-facing: every non-200 body must be
// { code, message } and nothing else. Pin the envelope here so a handler
// can't quietly drift back to bare { message } or grow extra fields.

describe("errorJson", () => {
  test("returns { code, message } with the given status", async () => {
    const app = new Hono();
    app.get("/", (c) =>
      errorJson(c, 404, "building_not_found", "No data for building 'X'."),
    );

    const res = await app.request("/");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      code: "building_not_found",
      message: "No data for building 'X'.",
    });
  });
});

// Same sync discipline as enums.test.ts: the consumer-facing docs must
// list every code the API can emit. A code added to ERROR_CODES without a
// row in the MIGRATION.md error-responses table fails here.
describe("MIGRATION.md sync", () => {
  test("every error code is documented in MIGRATION.md", async () => {
    const doc = await Bun.file(new URL("../MIGRATION.md", import.meta.url)).text();
    for (const code of ERROR_CODES) {
      expect(doc).toContain(`\`${code}\``);
    }
  });
});

describe("clampId", () => {
  test("short ids pass through untouched", () => {
    expect(clampId("NL.IMBAG.PAND.0599100000654061")).toBe(
      "NL.IMBAG.PAND.0599100000654061",
    );
  });

  test("ids at exactly the limit pass through untouched", () => {
    const id = "x".repeat(64);
    expect(clampId(id)).toBe(id);
  });

  test("overlong ids are truncated with an ellipsis", () => {
    const id = "y".repeat(200);
    expect(clampId(id)).toBe(`${"y".repeat(64)}…`);
  });
});
