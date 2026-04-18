import { sql } from "./db.ts";

type IdFormat =
  | "bag_building"
  | "bag_legacy_building"
  | "gfm"
  | "cbs_neighborhood"
  | "unknown";

function detectFormat(input: string): IdFormat {
  const id = input.replaceAll(" ", "").toUpperCase();

  if (id.startsWith("NL.IMBAG.PAND.")) return "bag_building";
  if (id.length === 16 && id.substring(4, 6) === "10") return "bag_legacy_building";
  if (id.startsWith("GFM-")) return "gfm";
  if (id.length === 10 && id.startsWith("BU")) return "cbs_neighborhood";

  return "unknown";
}

/**
 * Resolve any identifier to a BAG external building ID (NL.IMBAG.PAND.*).
 * Returns null if the identifier cannot be resolved.
 */
export async function resolveBuildingExternalId(input: string): Promise<string | null> {
  const format = detectFormat(input);

  switch (format) {
    case "bag_building":
      return input.replaceAll(" ", "").toUpperCase();

    case "bag_legacy_building":
      return `NL.IMBAG.PAND.${input.replaceAll(" ", "").toUpperCase()}`;

    default:
      return null;
  }
}

/**
 * Resolve any identifier to a GFM neighborhood ID (used by statistics tables).
 * For CBS neighborhood codes, translates external_id → internal GFM id.
 * For building identifiers, looks up via model_risk_static.
 */
export async function resolveNeighborhoodId(input: string): Promise<string | null> {
  const format = detectFormat(input);

  if (format === "cbs_neighborhood") {
    const rows = await sql`
      SELECT id FROM geocoder.neighborhood WHERE external_id = ${input} LIMIT 1
    `;
    return rows[0]?.id ?? null;
  }

  if (format === "gfm") {
    const rows = await sql`
      SELECT neighborhood_id FROM data.model_risk_static
      WHERE building_id = ${input}
      LIMIT 1
    `;
    return rows[0]?.neighborhood_id ?? null;
  }

  const externalId = await resolveBuildingExternalId(input);
  if (!externalId) return null;

  const rows = await sql`
    SELECT neighborhood_id FROM data.model_risk_static
    WHERE building_id = ${externalId}
    LIMIT 1
  `;
  return rows[0]?.neighborhood_id ?? null;
}
