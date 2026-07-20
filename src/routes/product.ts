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
// the three component risks plus the unclassified (construction-year
// fallback) risk as an indicative-reliability component (issue #1002);
// recoveryType overrides them to A,established.
// The component risks and restoration costs are inputs only, never
// returned — the response is the single verdict (issue #1010).
product.get("/light/:id", rateLimit("light3"), async (c) => {
  const id = c.req.param("id");
  const resolution = await resolveBuilding(id);
  if (!resolution.ok) return resolutionError(c, id, resolution.reason);
  const externalId = resolution.externalId;

  const rows = await sql`
    SELECT
      drystand_risk         AS "drystandRisk",
      drystand_risk_reliability AS "drystandRiskReliability",
      bio_infection_risk    AS "bioInfectionRisk",
      bio_infection_risk_reliability AS "bioInfectionRiskReliability",
      dewatering_depth_risk AS "dewateringDepthRisk",
      dewatering_depth_risk_reliability AS "dewateringDepthRiskReliability",
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

  const row = rows[0] as {
    drystandRisk: Risk | null;
    drystandRiskReliability: Reliability | null;
    bioInfectionRisk: Risk | null;
    bioInfectionRiskReliability: Reliability | null;
    dewateringDepthRisk: Risk | null;
    dewateringDepthRiskReliability: Reliability | null;
    unclassifiedRisk: Risk | null;
    recoveryType: RecoveryType | null;
  };

  // unclassified_risk carries no reliability pair in the model; it's the
  // construction-year fallback (issue #1002), so it enters as indicative —
  // any real component outranks it on the reliability-first ordering.
  const overall = computeOverallRisk(
    [
      { risk: row.drystandRisk, reliability: row.drystandRiskReliability },
      { risk: row.bioInfectionRisk, reliability: row.bioInfectionRiskReliability },
      { risk: row.dewateringDepthRisk, reliability: row.dewateringDepthRiskReliability },
      { risk: row.unclassifiedRisk, reliability: "indicative" },
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
    overallRisk: overall.risk,
    overallRiskReliability: overall.reliability,
  });
});

// /v4/product/facade_scan and /v4/product/foundation-research — summarized
// outcomes of *actually performed* research (issue Laixer/FunderMaps#1003),
// complementing the model-based `analysis` for the NWWI valuation chain.
// Building-level: the latest inquiry of the given type (by document_date)
// whose report is still fresh — facade scan (QuickScan) 3 years,
// foundation research 5 years. `validUntil` = document_date + that window.
//
// The facade classifications reuse the exact derivation behind the public
// maplayer.facade_scan map layer: a stored classification enum wins,
// otherwise the raw measurement is classified (skewed_* in mm,
// settlement_speed in mm/year); facadeCrack is the worst of the four
// facade-crack observations.
//
// settlement_speed is entered NEGATIVE (zakking = -mm/yr; the table has
// CHECK (settlement_speed <= 0) since 2026-08-22). Classify on abs() so the
// sign can never bucket a sinking house as 'nil' — before this, 1,096 of
// 1,277 facade-scan settlements were served as 'nil' because the entry
// conventions were split between authors.
//
// Deliberately NOT filtered on audit_status: the facade-scan intake is
// bulk-imported and sits at pending_review (6.1k of 6.1k) — the public
// facade_scan map layer serves the same rows without an audit filter, so
// filtering here would empty the product.
//
// The upper document_date bound guards against future-dated data-entry
// errors (real examples in prod: 2062, even year 19229) winning "latest"
// and producing absurd validUntil values.
async function latestResearchOutcome(
  externalId: string,
  type: "facade_scan" | "foundation_research",
  freshnessYears: number,
) {
  const rows = await sql`
    SELECT
      s.building_id AS "buildingId",
      i.id          AS "inquiryId",
      i.type::text  AS "inquiryType",
      to_char(i.document_date, 'YYYY-MM-DD') AS "documentDate",
      to_char(i.document_date + make_interval(years => ${freshnessYears}), 'YYYY-MM-DD') AS "validUntil",
      s.facade_scan_risk::text AS "facadeScanRisk",
      CASE
        WHEN abs(s.settlement_speed) < 0.5 THEN 'nil'
        WHEN abs(s.settlement_speed) < 2   THEN 'small'
        WHEN abs(s.settlement_speed) < 3   THEN 'mediocre'
        WHEN abs(s.settlement_speed) < 4   THEN 'big'
        WHEN abs(s.settlement_speed) >= 4  THEN 'very_big'
      END AS "settlementSpeed",
      COALESCE(s.skewed_parallel_facade, CASE
        WHEN s.skewed_parallel < 75   THEN 'very_big'::report.rotation_type
        WHEN s.skewed_parallel < 100  THEN 'big'
        WHEN s.skewed_parallel < 200  THEN 'mediocre'
        WHEN s.skewed_parallel < 300  THEN 'small'
        WHEN s.skewed_parallel >= 300 THEN 'nil'
      END)::text AS "skewedParallelFacade",
      COALESCE(s.skewed_perpendicular_facade, CASE
        WHEN s.skewed_perpendicular < 75   THEN 'very_big'::report.rotation_type
        WHEN s.skewed_perpendicular < 100  THEN 'big'
        WHEN s.skewed_perpendicular < 200  THEN 'mediocre'
        WHEN s.skewed_perpendicular < 300  THEN 'small'
        WHEN s.skewed_perpendicular >= 300 THEN 'nil'
      END)::text AS "skewedPerpendicularFacade",
      GREATEST(
        COALESCE(s.crack_facade_front_type, CASE
          WHEN s.crack_facade_front_size::integer = 0 THEN 'nil'::report.crack_type
          WHEN s.crack_facade_front_size::integer = 1 THEN 'small'
          WHEN s.crack_facade_front_size::integer < 3 THEN 'mediocre'
          WHEN s.crack_facade_front_size::integer >= 3 THEN 'big'
        END),
        COALESCE(s.crack_facade_back_type, CASE
          WHEN s.crack_facade_back_size::integer = 0 THEN 'nil'::report.crack_type
          WHEN s.crack_facade_back_size::integer = 1 THEN 'small'
          WHEN s.crack_facade_back_size::integer < 3 THEN 'mediocre'
          WHEN s.crack_facade_back_size::integer >= 3 THEN 'big'
        END),
        COALESCE(s.crack_facade_left_type, CASE
          WHEN s.crack_facade_left_size::integer = 0 THEN 'nil'::report.crack_type
          WHEN s.crack_facade_left_size::integer = 1 THEN 'small'
          WHEN s.crack_facade_left_size::integer < 3 THEN 'mediocre'
          WHEN s.crack_facade_left_size::integer >= 3 THEN 'big'
        END),
        COALESCE(s.crack_facade_right_type, CASE
          WHEN s.crack_facade_right_size::integer = 0 THEN 'nil'::report.crack_type
          WHEN s.crack_facade_right_size::integer = 1 THEN 'small'
          WHEN s.crack_facade_right_size::integer < 3 THEN 'mediocre'
          WHEN s.crack_facade_right_size::integer >= 3 THEN 'big'
        END)
      )::text AS "facadeCrack",
      s.overall_quality::text  AS "overallQuality",
      s.recovery_advised       AS "recoveryAdvised",
      s.enforcement_term::text AS "enforcementTerm",
      con.name                 AS "contractor"
    FROM report.inquiry i
    JOIN report.inquiry_sample s ON s.inquiry_id = i.id
    LEFT JOIN application.attribution a ON a.id = i.attribution_id
    LEFT JOIN application.contractor con ON con.id = a.contractor_id
    WHERE s.building_id = ${externalId}
      AND i.type = ${type}::report.inquiry_type
      AND i.delete_date IS NULL
      AND s.delete_date IS NULL
      AND i.document_date > CURRENT_DATE - make_interval(years => ${freshnessYears})
      AND i.document_date <= CURRENT_DATE + interval '3 months'
    ORDER BY i.document_date DESC, s.create_date DESC
    LIMIT 1
  `;
  return rows[0];
}

// Shared 404 tail for the research endpoints: building-shaped failures keep
// the standard reasons; a known building without (fresh) research gets a
// product-specific no_data_available message.
async function researchNotFound(
  c: Context,
  id: string,
  externalId: string,
  productLabel: string,
  freshnessYears: number,
) {
  const reason = await classifyMissingBuildingData(externalId);
  if (reason !== "no_data_available") {
    return resolutionError(c, externalId, reason);
  }
  return errorJson(
    c,
    404,
    "no_data_available",
    `Building '${clampId(id)}' is known, but no ${productLabel} result from the last ${freshnessYears} years is available for it.`,
  );
}

product.get("/facade_scan/:id", rateLimit("facade_scan4"), async (c) => {
  const id = c.req.param("id");
  const resolution = await resolveBuilding(id);
  if (!resolution.ok) return resolutionError(c, id, resolution.reason);
  const externalId = resolution.externalId;

  const row = await latestResearchOutcome(externalId, "facade_scan", 3);
  if (!row) {
    return researchNotFound(c, id, externalId, "facade scan (QuickScan)", 3);
  }

  c.set("tracker", {
    tenantId: c.get("tenantId"),
    product: "facade_scan4",
    buildingId: externalId,
    identifier: id,
  });

  return c.json({
    buildingId: row.buildingId,
    inquiryId: row.inquiryId,
    inquiryType: row.inquiryType,
    documentDate: row.documentDate,
    validUntil: row.validUntil,
    facadeScanRisk: row.facadeScanRisk,
    settlementSpeed: row.settlementSpeed,
    skewedParallelFacade: row.skewedParallelFacade,
    skewedPerpendicularFacade: row.skewedPerpendicularFacade,
    facadeCrack: row.facadeCrack,
    contractor: row.contractor,
  });
});

product.get(
  "/foundation-research/:id",
  rateLimit("foundation_research4"),
  async (c) => {
    const id = c.req.param("id");
    const resolution = await resolveBuilding(id);
    if (!resolution.ok) return resolutionError(c, id, resolution.reason);
    const externalId = resolution.externalId;

    const row = await latestResearchOutcome(
      externalId,
      "foundation_research",
      5,
    );
    if (!row) {
      return researchNotFound(c, id, externalId, "foundation research", 5);
    }

    c.set("tracker", {
      tenantId: c.get("tenantId"),
      product: "foundation_research4",
      buildingId: externalId,
      identifier: id,
    });

    return c.json({
      buildingId: row.buildingId,
      inquiryId: row.inquiryId,
      inquiryType: row.inquiryType,
      documentDate: row.documentDate,
      validUntil: row.validUntil,
      settlementSpeed: row.settlementSpeed,
      skewedParallelFacade: row.skewedParallelFacade,
      skewedPerpendicularFacade: row.skewedPerpendicularFacade,
      facadeCrack: row.facadeCrack,
      overallQuality: row.overallQuality,
      recoveryAdvised: row.recoveryAdvised,
      enforcementTerm: row.enforcementTerm,
      contractor: row.contractor,
    });
  },
);

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
