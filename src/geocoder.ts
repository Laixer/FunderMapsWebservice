import { sql } from "./db.ts";

type IdFormat =
  | "bag_building"
  | "bag_legacy_building"
  | "bag_address"
  | "bag_legacy_address"
  | "gfm"
  | "cbs_neighborhood"
  | "unknown";

function detectFormat(input: string): IdFormat {
  const id = input.replaceAll(" ", "").toUpperCase();

  if (id.startsWith("NL.IMBAG.PAND.")) return "bag_building";
  if (id.startsWith("NL.IMBAG.NUMMERAANDUIDING.")) return "bag_address";
  if (/^\d{4}10\d{10}$/.test(id)) return "bag_legacy_building";
  if (/^\d{4}20\d{10}$/.test(id)) return "bag_legacy_address";
  if (/^\d{3}20\d{10}$/.test(id)) return "bag_legacy_address";
  if (id.startsWith("GFM-")) return "gfm";
  if (/^BU\d{8}$/.test(id)) return "cbs_neighborhood";

  return "unknown";
}

/**
 * Resolve any identifier to a BAG external building ID (NL.IMBAG.PAND.*).
 * Returns null if the identifier cannot be resolved.
 *
 * Address inputs (nummeraanduiding) are resolved via geocoder.address →
 * geocoder.building. Address → building is N:1 in BAG, so two
 * nummeraanduidingen on the same pand resolve to the same building.
 */
export async function resolveBuildingExternalId(input: string): Promise<string | null> {
  const format = detectFormat(input);
  const id = input.replaceAll(" ", "").toUpperCase();

  switch (format) {
    case "bag_building":
      return id;

    case "bag_legacy_building":
      return `NL.IMBAG.PAND.${id}`;

    case "bag_address":
    case "bag_legacy_address": {
      const externalAddressId =
        format === "bag_address"
          ? id
          : `NL.IMBAG.NUMMERAANDUIDING.${id.length === 15 ? `0${id}` : id}`;
      const rows = await sql`
        SELECT building_id
        FROM geocoder.address
        WHERE external_id = ${externalAddressId}
        LIMIT 1
      `;
      return rows[0]?.building_id ?? null;
    }

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
