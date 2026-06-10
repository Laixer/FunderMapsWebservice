// Canonical enum value sets for every enum-typed column the product
// endpoints can return (issue #996).
//
// The API passes `data.model_risk_static` and `data.statistics_product_*`
// enum columns through verbatim, so the set of possible response values
// is exactly the label set of the backing Postgres enum types. These
// arrays mirror those types, in pg_enum sort order:
//
//   foundationType   → foundation_type
//   reliability      → reliability
//   foundationRisk   → foundation_risk_indication
//   damageCause      → foundation_damage_cause
//   inquiryType      → inquiry_type
//   recoveryType     → recovery_type
//
// This file is the single source of truth on the TS side. Two checks in
// enums.test.ts keep it honest:
//   1. (always, CI) the enum reference table in MIGRATION.md must list
//      exactly these values — the doc cannot drift from this file.
//   2. (ENUM_DB_CHECK=1, needs a real DATABASE_URL) these arrays must
//      match pg_enum — this file cannot drift from the database.
//
// If a label is added to a Postgres enum, run the DB check against that
// database, add the label here, and update MIGRATION.md; check 1 fails
// in CI until the doc is updated too.

export const FOUNDATION_TYPE = [
  "wood",
  "concrete",
  "no_pile",
  "wood_charger",
  "weighted_pile",
  "combined",
  "steel_pile",
  "other",
  "no_pile_masonry",
  "no_pile_strips",
  "no_pile_concrete_floor",
  "no_pile_slit",
  "wood_amsterdam",
  "wood_rotterdam",
  "no_pile_bearing_floor",
  "wood_rotterdam_amsterdam",
  "wood_rotterdam_arch",
  "wood_amsterdam_arch",
] as const;

export const RELIABILITY = [
  "indicative",
  "established",
  "cluster",
  "supercluster",
] as const;

export const FOUNDATION_RISK = ["a", "b", "c", "d", "e"] as const;

export const DAMAGE_CAUSE = [
  "drainage",
  "construction_flaw",
  "drystand",
  "overcharge",
  "overcharge_negative_cling",
  "negative_cling",
  "bio_infection",
  "fungus_infection",
  "bio_fungus_infection",
  "foundation_flaw",
  "construction_heave",
  "subsidence",
  "vegetation",
  "gas",
  "vibrations",
  "partial_foundation_recovery",
  "japanese_knotweed",
  "groundwater_level_reduction",
] as const;

export const INQUIRY_TYPE = [
  "monitoring",
  "note",
  "quickscan",
  "unknown",
  "demolition_research",
  "second_opinion",
  "archive_research",
  "architectural_research",
  "foundation_advice",
  "inspectionpit",
  "foundation_research",
  "additional_research",
  "ground_water_level_research",
  "soil_investigation",
  "facade_scan",
] as const;

export const RECOVERY_TYPE = [
  "table",
  "beam_on_pile",
  "pile_lowering",
  "pile_in_wall",
  "injection",
  "unknown",
] as const;

export type FoundationType = (typeof FOUNDATION_TYPE)[number];
export type Reliability = (typeof RELIABILITY)[number];
export type Risk = (typeof FOUNDATION_RISK)[number];
export type DamageCause = (typeof DAMAGE_CAUSE)[number];
export type InquiryType = (typeof INQUIRY_TYPE)[number];
export type RecoveryType = (typeof RECOVERY_TYPE)[number];

// MIGRATION.md "Enum reference" table rows, keyed by the field name used
// in the doc. Exported so the doc-sync test covers every set in one loop.
export const ENUM_REFERENCE: Record<string, readonly string[]> = {
  foundationType: FOUNDATION_TYPE,
  reliability: RELIABILITY,
  foundationRisk: FOUNDATION_RISK,
  damageCause: DAMAGE_CAUSE,
  inquiryType: INQUIRY_TYPE,
  recoveryType: RECOVERY_TYPE,
};

// Postgres enum type behind each documented field, for the DB-sync check.
export const PG_ENUM_TYPES: Record<string, string> = {
  foundationType: "foundation_type",
  reliability: "reliability",
  foundationRisk: "foundation_risk_indication",
  damageCause: "foundation_damage_cause",
  inquiryType: "inquiry_type",
  recoveryType: "recovery_type",
};
