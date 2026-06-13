import { describe, test, expect } from "bun:test";
import { decide, secondsUntilReset, windowStart } from "./rate-limit.ts";

// Window math + the allow/deny decision are the rate-limit code paths that
// can silently misbehave for hours before anyone notices (off-by-one on a
// month boundary, mid-second timezone slip, decide returning the wrong
// remaining count). All three are pure, so we test them directly.

describe("windowStart", () => {
  test("day → start of current UTC day", () => {
    expect(windowStart("day", new Date("2026-06-01T14:23:45Z"))).toEqual(
      new Date("2026-06-01T00:00:00Z"),
    );
  });

  test("day → handles the UTC midnight boundary exactly", () => {
    expect(windowStart("day", new Date("2026-06-01T00:00:00Z"))).toEqual(
      new Date("2026-06-01T00:00:00Z"),
    );
  });

  test("month → first-of-month UTC at 00:00", () => {
    expect(windowStart("month", new Date("2026-06-15T09:30:00Z"))).toEqual(
      new Date("2026-06-01T00:00:00Z"),
    );
  });

  test("month → handles the first-of-month boundary exactly", () => {
    expect(windowStart("month", new Date("2026-06-01T00:00:00Z"))).toEqual(
      new Date("2026-06-01T00:00:00Z"),
    );
  });
});

describe("secondsUntilReset", () => {
  test("day → seconds remaining until next UTC midnight", () => {
    const now = new Date("2026-06-01T23:59:00Z");
    expect(secondsUntilReset("day", now)).toBe(60);
  });

  test("day → exactly 24h remain at the start of a day", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    expect(secondsUntilReset("day", now)).toBe(86_400);
  });

  test("month → handles month rollover correctly (Jun→Jul)", () => {
    const now = new Date("2026-06-30T23:59:00Z");
    expect(secondsUntilReset("month", now)).toBe(60);
  });

  test("month → handles year rollover (Dec→Jan)", () => {
    const now = new Date("2026-12-31T23:59:00Z");
    expect(secondsUntilReset("month", now)).toBe(60);
  });

  test("never returns 0 at the exact boundary (header must be well-formed)", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    expect(secondsUntilReset("day", now)).toBeGreaterThanOrEqual(1);
    expect(secondsUntilReset("month", now)).toBeGreaterThanOrEqual(1);
  });
});

describe("decide", () => {
  test("under the limit → allowed, remaining counts down", () => {
    expect(decide({ period: "day", limit: 100 }, 25)).toEqual({
      allowed: true,
      remaining: 75,
    });
  });

  test("at the limit (count === limit) → blocked, 0 remaining", () => {
    expect(decide({ period: "day", limit: 100 }, 100)).toEqual({
      allowed: false,
      remaining: 0,
    });
  });

  test("over the limit → blocked, remaining floored at 0", () => {
    expect(decide({ period: "day", limit: 100 }, 250)).toEqual({
      allowed: false,
      remaining: 0,
    });
  });

  test("zero limit → always blocked", () => {
    expect(decide({ period: "day", limit: 0 }, 0)).toEqual({
      allowed: false,
      remaining: 0,
    });
  });
});
