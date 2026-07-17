import { sql } from "./db.ts";

export type IdFormat =
  | "bag_building"
  | "bag_legacy_building"
  | "bag_address"
  | "bag_legacy_address"
  | "gfm"
  | "cbs_neighborhood"
  | "unknown";

export function detectFormat(input: string): IdFormat {
  const id = input.replaceAll(" ", "").toUpperCase();

  // No identifier format contains control characters. A NUL byte in particular
  // reaches Postgres as a bind parameter and raises `invalid byte sequence for
  // encoding "UTF8": 0x00`, which would otherwise escape the route handler as a
  // 500. Classify any control char as unrecognized so the route returns a clean
  // 404 instead. (Found via input fuzzing, 2026-06-04.)
  if ([...id].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return "unknown";

  if (id.startsWith("NL.IMBAG.PAND.")) return "bag_building";
  if (id.startsWith("NL.IMBAG.NUMMERAANDUIDING.")) return "bag_address";
  if (/^\d{4}10\d{10}$/.test(id)) return "bag_legacy_building";
  if (/^\d{4}20\d{10}$/.test(id)) return "bag_legacy_address";
  if (/^\d{3}20\d{10}$/.test(id)) return "bag_legacy_address";
  if (id.startsWith("GFM-")) return "gfm";
  if (/^BU\d{8}$/.test(id)) return "cbs_neighborhood";

  return "unknown";
}

// Resolution failures carry a reason so consumers can pick the right
// follow-up step (issue Laixer/FunderMaps#1002, NWWI integration):
// - invalid_format / address_not_found → the request itself is wrong;
//   resubmit with a corrected identifier.
// - not_a_building → the identifier points at a ligplaats/standplaats
//   (houseboat mooring / mobile-home site) — foundation risk doesn't
//   apply and a QuickScan is pointless.
// - building_not_found → well-formed pand id with no BAG match.
// - no_data_available → the building exists; we just have no data for
//   it — the "request a QuickScan" case.
export type BuildingResolutionFailure =
  | "invalid_format"
  | "address_not_found"
  | "not_a_building";

export type BuildingResolution =
  | { ok: true; externalId: string }
  | { ok: false; reason: BuildingResolutionFailure };

// geocoder.address.building_id stores geocoder.building.external_id, which
// the BAG load also fills for ligplaats/standplaats objects (see
// FunderMapsWorker sql/load/load_{building,address}.sql). The prefix is
// enough to spot the non-pand objects without an extra query.
const NON_BUILDING_PREFIX = /^NL\.IMBAG\.(LIGPLAATS|STANDPLAATS)\./;

/**
 * Resolve any identifier to a BAG external building ID (NL.IMBAG.PAND.*).
 *
 * Address inputs (nummeraanduiding) are resolved via geocoder.address →
 * geocoder.building. Address → building is N:1 in BAG, so two
 * nummeraanduidingen on the same pand resolve to the same building.
 *
 * Pand inputs resolve as identity WITHOUT an existence check — the happy
 * path stays a single product query. Use classifyMissingBuildingData()
 * when the subsequent data lookup comes up empty to tell "unknown
 * building" apart from "known building, no data".
 */
export async function resolveBuilding(input: string): Promise<BuildingResolution> {
  const format = detectFormat(input);
  const id = input.replaceAll(" ", "").toUpperCase();

  switch (format) {
    case "bag_building":
      return { ok: true, externalId: id };

    case "bag_legacy_building":
      return { ok: true, externalId: `NL.IMBAG.PAND.${id}` };

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
      const buildingId = rows[0]?.building_id as string | undefined;
      if (!buildingId) return { ok: false, reason: "address_not_found" };
      if (NON_BUILDING_PREFIX.test(buildingId)) {
        return { ok: false, reason: "not_a_building" };
      }
      return { ok: true, externalId: buildingId };
    }

    default:
      return { ok: false, reason: "invalid_format" };
  }
}

// Ran only on the miss path (product query returned no rows), so the
// extra point-lookup never taxes a billable hit.
export type MissingDataReason =
  | "building_not_found"
  | "not_a_building"
  | "no_data_available";

export async function classifyMissingBuildingData(
  externalId: string,
): Promise<MissingDataReason> {
  const rows = await sql`
    SELECT building_type
    FROM geocoder.building
    WHERE external_id = ${externalId}
    LIMIT 1
  `;
  if (rows.length === 0) return "building_not_found";
  const type = rows[0]!.building_type as string | null;
  // Defensive: resolveBuilding() already rejects ligplaats/standplaats
  // reached via an address, but a building_id could land here through a
  // future call site.
  if (type === "houseboat" || type === "mobile_home") return "not_a_building";
  return "no_data_available";
}

export type NeighborhoodResolutionFailure =
  | BuildingResolutionFailure
  | MissingDataReason
  | "neighborhood_not_found";

export type NeighborhoodResolution =
  | { ok: true; neighborhoodId: string }
  | { ok: false; reason: NeighborhoodResolutionFailure };

/**
 * Resolve any identifier to a GFM neighborhood ID (used by statistics tables).
 * For CBS neighborhood codes, translates external_id → internal GFM id.
 * For building identifiers, looks up via model_risk_static; a miss there is
 * classified like the product endpoints classify it.
 */
export async function resolveNeighborhood(input: string): Promise<NeighborhoodResolution> {
  const format = detectFormat(input);

  if (format === "cbs_neighborhood") {
    const rows = await sql`
      SELECT id FROM geocoder.neighborhood WHERE external_id = ${input} LIMIT 1
    `;
    const neighborhoodId = rows[0]?.id as string | undefined;
    if (!neighborhoodId) return { ok: false, reason: "neighborhood_not_found" };
    return { ok: true, neighborhoodId };
  }

  // GFM is intentionally not handled here. `model_risk_static.building_id`
  // is BAG, so a gfm-* input could never match against it — the old branch
  // was dead code. v4 returns 404 on gfm-* by design (see CLAUDE.md).

  const building = await resolveBuilding(input);
  if (!building.ok) return building;

  const rows = await sql`
    SELECT neighborhood_id FROM data.model_risk_static
    WHERE building_id = ${building.externalId}
    LIMIT 1
  `;
  const neighborhoodId = rows[0]?.neighborhood_id as string | undefined;
  if (!neighborhoodId) {
    return {
      ok: false,
      reason: await classifyMissingBuildingData(building.externalId),
    };
  }
  return { ok: true, neighborhoodId };
}
