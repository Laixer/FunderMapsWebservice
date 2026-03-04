import { sql } from "./db.ts";

type IdFormat =
  | "bag_building"
  | "bag_address"
  | "bag_legacy_building"
  | "bag_legacy_address"
  | "gfm"
  | "cbs_neighborhood"
  | "cbs_district"
  | "cbs_municipality"
  | "unknown";

function detectFormat(input: string): IdFormat {
  const id = input.replaceAll(" ", "").toUpperCase();

  if (id.startsWith("NL.IMBAG.PAND.")) return "bag_building";
  if (id.startsWith("NL.IMBAG.NUMMERAANDUIDING.")) return "bag_address";

  if (id.length === 16 && id.substring(4, 6) === "10") return "bag_legacy_building";
  if (id.length === 16 && id.substring(4, 6) === "20") return "bag_legacy_address";

  if (id.startsWith("GFM-")) return "gfm";

  if (id.length === 10 && id.startsWith("BU")) return "cbs_neighborhood";
  if (id.length === 8 && id.startsWith("WK")) return "cbs_district";
  if (id.length === 6 && id.startsWith("GM")) return "cbs_municipality";

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
      return input;

    case "bag_legacy_building":
      return `NL.IMBAG.PAND.${input.replaceAll(" ", "").toUpperCase()}`;

    case "bag_address":
    case "bag_legacy_address": {
      const addressId = format === "bag_legacy_address"
        ? `NL.IMBAG.NUMMERAANDUIDING.${input.replaceAll(" ", "").toUpperCase()}`
        : input;
      const rows = await sql`
        SELECT b.external_id
        FROM geocoder.building b
        JOIN geocoder.address a ON a.building_id = b.id
        WHERE a.external_id = ${addressId}
        LIMIT 1
      `;
      return rows[0]?.external_id ?? null;
    }

    case "gfm": {
      const rows = await sql`
        SELECT external_building_id
        FROM data.model_risk_static
        WHERE building_id = ${input}
        LIMIT 1
      `;
      return rows[0]?.external_building_id ?? null;
    }

    default:
      return null;
  }
}

/**
 * Resolve a BAG external building ID to the GFM internal building ID.
 * Used for product tracking (product_tracker.building_id is geocoder.geocoder_id).
 */
export async function resolveGfmBuildingId(externalBuildingId: string): Promise<string | null> {
  const rows = await sql`
    SELECT id FROM geocoder.building WHERE external_id = ${externalBuildingId} LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

/**
 * Resolve any identifier to a GFM neighborhood ID (used by statistics tables).
 * For CBS codes, translates external_id → internal GFM id.
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

  if (format === "cbs_district") {
    const rows = await sql`
      SELECT id FROM geocoder.district WHERE external_id = ${input} LIMIT 1
    `;
    return rows[0]?.id ?? null;
  }

  if (format === "cbs_municipality") {
    const rows = await sql`
      SELECT id FROM geocoder.municipality WHERE external_id = ${input} LIMIT 1
    `;
    return rows[0]?.id ?? null;
  }

  // For GFM building IDs, query model_risk_static directly
  if (format === "gfm") {
    const rows = await sql`
      SELECT neighborhood_id FROM data.model_risk_static
      WHERE building_id = ${input}
      LIMIT 1
    `;
    return rows[0]?.neighborhood_id ?? null;
  }

  // For BAG building/address IDs, resolve to external_building_id first
  const externalId = await resolveBuildingExternalId(input);
  if (!externalId) return null;

  const rows = await sql`
    SELECT neighborhood_id FROM data.model_risk_static
    WHERE external_building_id = ${externalId}
    LIMIT 1
  `;
  return rows[0]?.neighborhood_id ?? null;
}
