import { Hono } from "hono";
import type { Context } from "hono";
import { sql } from "../db.ts";
import { clampId, errorJson } from "../errors.ts";
import {
  classifyMissingBuildingData,
  resolveBuilding,
  resolveNeighborhood,
  type NeighborhoodResolutionFailure,
} from "../geocoder.ts";
import { rateLimit } from "../rate-limit.ts";
import {
  computeOverallRisk,
  type RecoveryType,
  type Reliability,
  type Risk,
} from "../risk.ts";
import type { AppEnv } from "../index.ts";

const product = new Hono<AppEnv>();

// One 404 body per resolution-failure reason, so a consumer can pick the
// follow-up step from `code` alone (issue Laixer/FunderMaps#1002). The
// NeighborhoodResolutionFailure union is a superset of every reason the
// building endpoints can produce.
function resolutionError(
  c: Context,
  id: string,
  reason: NeighborhoodResolutionFailure,
) {
  const shownId = clampId(id);
  switch (reason) {
    case "invalid_format":
      return errorJson(
        c,
        404,
        "identifier_invalid",
        `Identifier '${shownId}' is not a recognized building, address, or neighborhood identifier format.`,
      );
    case "address_not_found":
      return errorJson(
        c,
        404,
        "address_not_found",
        `Address '${shownId}' is not a known BAG address.`,
      );
    case "not_a_building":
      return errorJson(
        c,
        404,
        "not_a_building",
        `Identifier '${shownId}' refers to a mooring or mobile-home site (ligplaats/standplaats), not a building. No foundation data exists for these objects.`,
      );
    case "building_not_found":
      return errorJson(
        c,
        404,
        "building_not_found",
        `Building '${shownId}' is not a known BAG building.`,
      );
    case "no_data_available":
      return errorJson(
        c,
        404,
        "no_data_available",
        `Building '${shownId}' is known, but no foundation data is available for it.`,
      );
    case "neighborhood_not_found":
      return errorJson(
        c,
        404,
        "neighborhood_not_found",
        `Neighborhood '${shownId}' is not a known CBS neighborhood.`,
      );
  }
}

product.get("/analysis/:id", rateLimit("analysis3"), async (c) => {
  const id = c.req.param("id");
  const resolution = await resolveBuilding(id);
  if (!resolution.ok) return resolutionError(c, id, resolution.reason);
  const externalId = resolution.externalId;

  const rows = await sql`
    SELECT
      building_id           AS "buildingId",
      neighborhood_id       AS "neighborhoodId",
      construction_year     AS "constructionYear",
      construction_year_reliability AS "constructionYearReliability",
      foundation_type       AS "foundationType",
      foundation_type_reliability AS "foundationTypeReliability",
      restoration_costs     AS "restorationCosts",
      height,
      velocity,
      ground_water_level    AS "groundWaterLevel",
      ground_level          AS "groundLevel",
      soil,
      surface_area          AS "surfaceArea",
      damage_cause          AS "damageCause",
      inquiry_type          AS "inquiryType",
      drystand,
      drystand_risk         AS "drystandRisk",
      drystand_risk_reliability AS "drystandReliability",
      bio_infection_risk    AS "bioInfectionRisk",
      bio_infection_risk_reliability AS "bioInfectionReliability",
      dewatering_depth      AS "dewateringDepth",
      dewatering_depth_risk AS "dewateringDepthRisk",
      dewatering_depth_risk_reliability AS "dewateringDepthReliability",
      unclassified_risk     AS "unclassifiedRisk",
      recovery_type         AS "recoveryType",
      -- Number of addresses (nummeraanduidingen) on this BAG pand. Consumers
      -- use it to split restoration costs per address/object within a single
      -- building (see issue #988). Precomputed in the view (== count of
      -- geocoder.address rows for this building_id).
      address_count         AS "addressCount"
    FROM data.model_risk_static
    WHERE building_id = ${externalId}
    LIMIT 1
  `;

  if (rows.length === 0) {
    return resolutionError(
      c,
      externalId,
      await classifyMissingBuildingData(externalId),
    );
  }

  c.set("tracker", {
    tenantId: c.get("tenantId"),
    product: "analysis3",
    buildingId: externalId,
    identifier: id,
  });

  return c.json(rows[0]);
});

// /v4/product/risk — subset of `analysis` aimed at financial / valuation
// chains and dashboards (issue #985). Same data source, fewer fields.
product.get("/risk/:id", rateLimit("risk3"), async (c) => {
  const id = c.req.param("id");
  const resolution = await resolveBuilding(id);
  if (!resolution.ok) return resolutionError(c, id, resolution.reason);
  const externalId = resolution.externalId;

  const rows = await sql`
    SELECT
      building_id           AS "buildingId",
      foundation_type       AS "foundationType",
      foundation_type_reliability AS "foundationTypeReliability",
      restoration_costs     AS "restorationCosts",
      inquiry_type          AS "inquiryType",
      drystand_risk         AS "drystandRisk",
      drystand_risk_reliability AS "drystandReliability",
      bio_infection_risk    AS "bioInfectionRisk",
      bio_infection_risk_reliability AS "bioInfectionReliability",
      dewatering_depth_risk AS "dewateringDepthRisk",
      dewatering_depth_risk_reliability AS "dewateringDepthReliability",
      unclassified_risk     AS "unclassifiedRisk",
      recovery_type         AS "recoveryType"
    FROM data.model_risk_static
    WHERE building_id = ${externalId}
    LIMIT 1
  `;

  if (rows.length === 0) {
    return resolutionError(
      c,
      externalId,
      await classifyMissingBuildingData(externalId),
    );
  }

  c.set("tracker", {
    tenantId: c.get("tenantId"),
    product: "risk3",
    buildingId: externalId,
    identifier: id,
  });

  return c.json(rows[0]);
});

// /v4/product/light — minimal output for fast chain integrations
// (issue #985). overallRisk + overallRiskReliability are derived from
// the three component risks; recoveryType overrides them to A,established.
product.get("/light/:id", rateLimit("light3"), async (c) => {
  const id = c.req.param("id");
  const resolution = await resolveBuilding(id);
  if (!resolution.ok) return resolutionError(c, id, resolution.reason);
  const externalId = resolution.externalId;

  const rows = await sql`
    SELECT
      restoration_costs     AS "restorationCosts",
      drystand_risk         AS "drystandRisk",
      drystand_risk_reliability AS "drystandRiskReliability",
      bio_infection_risk    AS "bioInfectionRisk",
      bio_infection_risk_reliability AS "bioInfectionRiskReliability",
      dewatering_depth_risk AS "dewateringDepthRisk",
      dewatering_depth_risk_reliability AS "dewateringDepthRiskReliability",
      recovery_type         AS "recoveryType"
    FROM data.model_risk_static
    WHERE building_id = ${externalId}
    LIMIT 1
  `;

  if (rows.length === 0) {
    return resolutionError(
      c,
      externalId,
      await classifyMissingBuildingData(externalId),
    );
  }

  const row = rows[0] as {
    restorationCosts: number | null;
    drystandRisk: Risk | null;
    drystandRiskReliability: Reliability | null;
    bioInfectionRisk: Risk | null;
    bioInfectionRiskReliability: Reliability | null;
    dewateringDepthRisk: Risk | null;
    dewateringDepthRiskReliability: Reliability | null;
    recoveryType: RecoveryType | null;
  };

  const overall = computeOverallRisk(
    [
      { risk: row.drystandRisk, reliability: row.drystandRiskReliability },
      { risk: row.bioInfectionRisk, reliability: row.bioInfectionRiskReliability },
      { risk: row.dewateringDepthRisk, reliability: row.dewateringDepthRiskReliability },
    ],
    row.recoveryType,
  );

  c.set("tracker", {
    tenantId: c.get("tenantId"),
    product: "light3",
    buildingId: externalId,
    identifier: id,
  });

  return c.json({
    restorationCosts: row.restorationCosts,
    drystandRisk: row.drystandRisk,
    overallRisk: overall.risk,
    overallRiskReliability: overall.reliability,
  });
});

product.get("/statistics/:id", rateLimit("statistics3"), async (c) => {
  const id = c.req.param("id");
  const resolution = await resolveNeighborhood(id);
  if (!resolution.ok) return resolutionError(c, id, resolution.reason);
  const neighborhoodId = resolution.neighborhoodId;

  // Resolve municipality via neighborhood → district → municipality
  const muniRows = await sql`
    SELECT d.municipality_id
    FROM geocoder.neighborhood n
    JOIN geocoder.district d ON d.id = n.district_id
    WHERE n.id = ${neighborhoodId}
    LIMIT 1
  `;
  const municipalityId = muniRows[0]?.municipality_id ?? null;

  const [
    foundationTypes,
    constructionYears,
    dataCollected,
    foundationRisk,
    buildingsRestored,
    incidentCounts,
    municipalityIncidents,
    reportCounts,
    municipalityReports,
  ] = await Promise.all([
    sql`
      SELECT foundation_type AS "foundationType", round(percentage::numeric, 2) AS percentage
      FROM data.statistics_product_foundation_type
      WHERE neighborhood_id = ${neighborhoodId}
    `,
    sql`
      SELECT year_from AS "yearFrom", count
      FROM data.statistics_product_construction_years
      WHERE neighborhood_id = ${neighborhoodId}
    `,
    sql`
      SELECT round(percentage::numeric, 2) AS percentage
      FROM data.statistics_product_data_collected
      WHERE neighborhood_id = ${neighborhoodId}
      LIMIT 1
    `,
    sql`
      SELECT foundation_risk AS "foundationRisk", round(percentage::numeric, 2) AS percentage
      FROM data.statistics_product_foundation_risk
      WHERE neighborhood_id = ${neighborhoodId}
    `,
    sql`
      SELECT count
      FROM data.statistics_product_buildings_restored
      WHERE neighborhood_id = ${neighborhoodId}
      LIMIT 1
    `,
    sql`
      SELECT year, count
      FROM data.statistics_product_incidents
      WHERE neighborhood_id = ${neighborhoodId}
    `,
    municipalityId
      ? sql`
          SELECT year, count
          FROM data.statistics_product_incident_municipality
          WHERE municipality_id = ${municipalityId}
        `
      : Promise.resolve([]),
    sql`
      SELECT year, count
      FROM data.statistics_product_inquiries
      WHERE neighborhood_id = ${neighborhoodId}
    `,
    municipalityId
      ? sql`
          SELECT year, count
          FROM data.statistics_product_inquiry_municipality
          WHERE municipality_id = ${municipalityId}
        `
      : Promise.resolve([]),
  ]);

  // Track usage
  const building = await resolveBuilding(id);
  if (building.ok) {
    c.set("tracker", {
      tenantId: c.get("tenantId"),
      product: "statistics3",
      buildingId: building.externalId,
      identifier: id,
    });
  }

  return c.json({
    foundationTypeDistribution: foundationTypes,
    constructionYearDistribution: constructionYears,
    dataCollectedPercentage: dataCollected[0]?.percentage ?? 0,
    foundationRiskDistribution: foundationRisk,
    totalBuildingRestoredCount: buildingsRestored[0]?.count ?? 0,
    totalIncidentCount: incidentCounts,
    municipalityIncidentCount: municipalityIncidents,
    totalReportCount: reportCounts,
    municipalityReportCount: municipalityReports,
  });
});

export default product;
