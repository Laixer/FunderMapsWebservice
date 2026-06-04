import { describe, test, expect } from "bun:test";
import { detectFormat, type IdFormat } from "./geocoder.ts";

// detectFormat is the input classifier that decides which lookup branch
// runs for an incoming `:id` parameter. A regression here either rejects
// valid customer IDs (regression visible as 404) or — worse — misclassifies
// one format as another and silently joins on the wrong column (returns
// wrong building data, billable). Table-driven so adding a new format is
// one row.

const cases: { input: string; expected: IdFormat; why: string }[] = [
  // BAG building (canonical and case/whitespace variants)
  { input: "NL.IMBAG.PAND.0344100000000001", expected: "bag_building", why: "canonical PAND" },
  { input: "nl.imbag.pand.0344100000000001", expected: "bag_building", why: "lowercase upcases first" },
  { input: "NL.IMBAG.PAND. 0344100000000001", expected: "bag_building", why: "internal whitespace stripped" },

  // BAG address (the c2296cd addition)
  { input: "NL.IMBAG.NUMMERAANDUIDING.0344200000000001", expected: "bag_address", why: "canonical NUMMERAANDUIDING" },
  { input: "nl.imbag.nummeraanduiding.0344200000000001", expected: "bag_address", why: "case-insensitive" },

  // Legacy BAG building: 16 digits with "10" at positions 4-5
  { input: "0344100000000001", expected: "bag_legacy_building", why: "16 digits, 10 at pos 4-5" },

  // Legacy BAG address: 16 digits with "20" at positions 4-5
  { input: "0344200000000001", expected: "bag_legacy_address", why: "16-digit form" },
  // Legacy BAG address: 15 digits with "20" at positions 3-4 (one byte short)
  { input: "034200000000001", expected: "bag_legacy_address", why: "15-digit short form" },

  // CBS neighborhood: BU + 8 digits, 10 chars total
  { input: "BU01234567", expected: "cbs_neighborhood", why: "canonical BU code" },
  { input: "bu01234567", expected: "cbs_neighborhood", why: "case-insensitive via toUpperCase()" },

  // GFM internal (intentionally classified but not resolved by v4 — see CLAUDE.md)
  { input: "gfm-abc123", expected: "gfm", why: "lowercase variant via toUpperCase()" },
  { input: "GFM-abc123", expected: "gfm", why: "uppercase variant" },

  // Unknown / rejected formats — must classify as "unknown" so the route
  // returns 404 instead of attempting a wildcard lookup.
  { input: "totally-bogus", expected: "unknown", why: "random string" },
  { input: "", expected: "unknown", why: "empty string" },
  { input: "BU0123456", expected: "unknown", why: "BU code one digit short" },
  { input: "BU012345678", expected: "unknown", why: "BU code one digit long" },
  { input: "WK0123", expected: "unknown", why: "CBS district intentionally not supported" },
  { input: "GM0123", expected: "unknown", why: "CBS municipality intentionally not supported" },
  { input: "1234300000000001", expected: "unknown", why: "16 digits but unrecognised middle pair (30)" },

  // Control characters (incl. NUL) must be rejected. A NUL after a PAND/
  // NUMMERAANDUIDING prefix would otherwise pass the startsWith() branch and
  // reach Postgres as a bind param, raising `invalid byte sequence for encoding
  // "UTF8": 0x00` → unhandled 500. Found via input fuzzing (2026-06-04).
  { input: "NL.IMBAG.PAND." + String.fromCharCode(0) + "0344100000000001", expected: "unknown", why: "NUL after PAND prefix (would 500 pre-fix)" },
  { input: "NL.IMBAG.PAND.0344100000000001" + String.fromCharCode(0), expected: "unknown", why: "trailing NUL on a PAND id" },
  { input: "NL.IMBAG.NUMMERAANDUIDING." + String.fromCharCode(0) + "0344200000000001", expected: "unknown", why: "NUL after NUMMERAANDUIDING prefix" },
  { input: "NL.IMBAG.PAND.0344100000" + String.fromCharCode(9) + "000001", expected: "unknown", why: "tab control char" },
  { input: "NL.IMBAG.PAND.0344100000" + String.fromCharCode(127) + "00001", expected: "unknown", why: "DEL (0x7f) control char" },
];

describe("detectFormat", () => {
  for (const { input, expected, why } of cases) {
    test(`"${input}" → ${expected} (${why})`, () => {
      expect(detectFormat(input)).toBe(expected);
    });
  }
});
