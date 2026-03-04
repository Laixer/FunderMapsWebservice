import { Hono } from "hono";
import { sql } from "../db.ts";
import { resolveBuildingExternalId, resolveGfmBuildingId, resolveNeighborhoodId } from "../geocoder.ts";
import type { AppEnv } from "../index.ts";

const product = new Hono<AppEnv>();

product.get("/analysis/:id", async (c) => {
  const id = c.req.param("id");
  const externalId = await resolveBuildingExternalId(id);
  if (!externalId) return c.json({ message: "Not found" }, 404);

  const rows = await sql`
    SELECT
      external_building_id  AS "buildingId",
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
      enforcement_term      AS "enforcementTerm",
      overall_quality       AS "overallQuality",
      recovery_type         AS "recoveryType"
    FROM data.model_risk_static
    WHERE external_building_id = ${externalId}
    LIMIT 1
  `;

  if (rows.length === 0) return c.json({ message: "Not found" }, 404);

  const gfmId = await resolveGfmBuildingId(externalId);
  if (gfmId) {
    c.set("tracker", {
      tenantId: c.get("tenantId"),
      product: "analysis3",
      buildingId: gfmId,
      identifier: id,
    });
  }

  return c.json(rows[0]);
});

product.get("/statistics/:id", async (c) => {
  const id = c.req.param("id");
  const neighborhoodId = await resolveNeighborhoodId(id);
  if (!neighborhoodId) return c.json({ message: "Not found" }, 404);

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
  const externalId = await resolveBuildingExternalId(id);
  if (externalId) {
    const gfmId = await resolveGfmBuildingId(externalId);
    if (gfmId) {
      c.set("tracker", {
        tenantId: c.get("tenantId"),
        product: "statistics3",
        buildingId: gfmId,
        identifier: id,
      });
    }
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
