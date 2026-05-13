import { describe, test, expect } from "bun:test";
import { extractKey, sha256Hex, sha256Base64Url } from "./auth.ts";

// extractKey pulls the API key out of `Authorization: Bearer fmsk.…`. It's
// the only auth header shape this service supports (the legacy `authkey`
// and `?authkey=` paths were removed in 9485134; `X-API-Key` in 257d98e).
// A regression here means every authed request 401s — easy to catch with a
// tiny test, expensive to discover in prod.

function ctx(headers: Record<string, string>) {
  return {
    req: {
      header: (name: string) => headers[name],
    },
  };
}

describe("extractKey", () => {
  test("Bearer fmsk.xxx → returns the key portion", () => {
    expect(extractKey(ctx({ Authorization: "Bearer fmsk.abc123" }))).toBe("fmsk.abc123");
  });

  test("case-insensitive scheme: bearer (lowercase) also matches", () => {
    expect(extractKey(ctx({ Authorization: "bearer fmsk.abc123" }))).toBe("fmsk.abc123");
  });

  test("extra whitespace between scheme and token is tolerated", () => {
    expect(extractKey(ctx({ Authorization: "Bearer    fmsk.abc123" }))).toBe("fmsk.abc123");
  });

  test("no Authorization header → null", () => {
    expect(extractKey(ctx({}))).toBeNull();
  });

  test("Authorization with non-Bearer scheme → null (not Basic, not AuthKey, etc.)", () => {
    expect(extractKey(ctx({ Authorization: "Basic abc123" }))).toBeNull();
    expect(extractKey(ctx({ Authorization: "AuthKey fmsk.abc123" }))).toBeNull();
  });

  test("X-API-Key header is intentionally ignored (removed in 257d98e)", () => {
    expect(extractKey(ctx({ "X-API-Key": "fmsk.abc123" }))).toBeNull();
  });

  test("Bearer with no token → null", () => {
    expect(extractKey(ctx({ Authorization: "Bearer" }))).toBeNull();
    expect(extractKey(ctx({ Authorization: "Bearer " }))).toBeNull();
  });
});

// sha256Hex and sha256Base64Url are the format pins for our two API-key
// stores. Drift in either format silently breaks auth — keys hashed by
// us no longer match what's stored, every request 401s. Pin them.

describe("sha256Hex", () => {
  // FIPS 180-4 documented test vector for SHA-256("abc").
  test('FIPS 180-4 vector: "abc"', async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("output is exactly 64 lowercase-hex characters", async () => {
    const hex = await sha256Hex("anything");
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  test("deterministic — same input twice gives same output", async () => {
    expect(await sha256Hex("fmsk.test-key")).toBe(await sha256Hex("fmsk.test-key"));
  });
});

describe("sha256Base64Url", () => {
  // Matches @better-auth/api-key's `defaultKeyHasher`:
  //   base64Url.encode(new Uint8Array(hash), { padding: false })
  // 32-byte SHA-256 → 43 base64url chars, no padding.
  test('"abc" → base64url-no-padding form of the SHA-256 hash', async () => {
    expect(await sha256Base64Url("abc")).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
  });

  test("output is exactly 43 chars, no padding, base64url alphabet only", async () => {
    const b64u = await sha256Base64Url("anything");
    expect(b64u).toHaveLength(43);
    expect(b64u).not.toContain("=");
    expect(b64u).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("uses base64url alphabet (- and _), not standard base64 (+ and /)", async () => {
    // sha256("abc") happens to produce a hash whose base64url form contains
    // both `-` and `_`. If this ever stops matching, the encoder switched
    // to standard base64 — would silently break BA-issued key validation.
    const b64u = await sha256Base64Url("abc");
    expect(b64u).toContain("-");
    expect(b64u).toContain("_");
  });
});
