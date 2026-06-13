import { describe, test, expect } from "bun:test";
import { ENUM_REFERENCE, PG_ENUM_TYPES } from "./enums.ts";

// Issue #996: the enum reference in MIGRATION.md drifted from what the
// API actually returns, and integrators built parsers against the wrong
// values. The API passes database enum labels through verbatim, so there
// are two links that can break:
//
//   pg_enum  ←→  src/enums.ts  ←→  MIGRATION.md
//
// The doc↔code link is checked on every CI run. The code↔db link needs a
// real database, which CI doesn't have — run it on demand:
//
//   ENUM_DB_CHECK=1 DATABASE_URL=postgres://... bun test src/enums.test.ts

// Extracts the value list for one field from the MIGRATION.md enum table.
// Matches rows of the form: | fieldName | `a`, `b`, ... |
function docValues(markdown: string, field: string): string[] {
  const row = markdown
    .split("\n")
    .find((line) => line.startsWith(`| ${field} |`));
  if (!row) return [];
  return [...row.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
}

describe("MIGRATION.md enum reference matches src/enums.ts", async () => {
  const markdown = await Bun.file(
    new URL("../MIGRATION.md", import.meta.url),
  ).text();

  for (const [field, values] of Object.entries(ENUM_REFERENCE)) {
    test(field, () => {
      expect(docValues(markdown, field)).toEqual([...values]);
    });
  }
});

describe.skipIf(!process.env.ENUM_DB_CHECK)(
  "src/enums.ts matches pg_enum",
  () => {
    for (const [field, typname] of Object.entries(PG_ENUM_TYPES)) {
      test(`${field} (${typname})`, async () => {
        const { sql } = await import("./db.ts");
        const rows = await sql`
          SELECT e.enumlabel
          FROM pg_type t
          JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE t.typname = ${typname}
          ORDER BY e.enumsortorder
        `;
        expect(rows.map((r) => r.enumlabel)).toEqual([
          ...ENUM_REFERENCE[field]!,
        ]);
      });
    }
  },
);
