// Derived overall-risk for /v4/product/light.
//
// The model surfaces separate component risks — drystand, bio-infection,
// dewatering-depth and the unclassified risk — each with a reliability
// label. The `light` product collapses them into one `overallRisk` plus
// its `overallRiskReliability`.
//
// The worst letter wins: `overallRisk` is the highest risk letter among
// the components, the same answer the map gives for the building. When
// several components share that letter, the most reliable of them
// supplies `overallRiskReliability`. (Until 2026-11 the order was the
// other way round — reliability first, issue #985 — so a more reliable
// lower letter could hide a less reliable higher one.)
//
// The unclassified risk has no reliability column of its own in the
// model. It is not a guess: the model sets it from research on the
// building, from a QuickScan, from a recovery, or carries it over from
// the same block, and records which (`unclassified_source`). That
// source decides its reliability here — see unclassifiedReliability.
//
// Override: if any recovery_type is known for this building (i.e. the
// foundation has been restored), overall_risk is A regardless of the
// model's component risks — a recovered building is the lowest risk
// class by definition. The override is reported as established
// reliability since the recovery flag itself is hard evidence.

import type { Reliability, RecoveryType, Risk } from "./enums.ts";

export type { Reliability, RecoveryType, Risk };

export interface RiskComponent {
  risk: Risk | null;
  reliability: Reliability | null;
}

export interface OverallRisk {
  risk: Risk | null;
  reliability: Reliability | null;
}

// Higher number = more authoritative (issue #985):
// established > cluster > supercluster > indicative. Used to pick the
// reliability when several components share the worst letter.
const RELIABILITY_RANK: Record<Reliability, number> = {
  established: 4,
  cluster: 3,
  supercluster: 2,
  indicative: 1,
};

const RISK_RANK: Record<Risk, number> = { e: 5, d: 4, c: 3, b: 2, a: 1 };

/**
 * The reliability that goes with the unclassified risk, from where the
 * model took it (data.model_risk_static_source.unclassified_source):
 * research, a QuickScan or a recovery on the building itself is
 * established; a class carried over from the block is cluster. A source
 * this code does not know counts as indicative, the most careful label.
 */
export function unclassifiedReliability(source: string | null | undefined): Reliability {
  switch (source) {
    case "research":
    case "quickscan":
    case "herstel":
      return "established";
    case "cluster":
      return "cluster";
    default:
      return "indicative";
  }
}

export function computeOverallRisk(
  components: RiskComponent[],
  recoveryType: RecoveryType | null,
): OverallRisk {
  if (recoveryType != null) {
    return { risk: "a", reliability: "established" };
  }

  // Only components with both fields populated can win — a risk class
  // without a reliability label can't be compared against the others.
  let best: { risk: Risk; reliability: Reliability } | null = null;
  for (const c of components) {
    if (c.risk == null || c.reliability == null) continue;
    if (
      best == null ||
      RISK_RANK[c.risk] > RISK_RANK[best.risk] ||
      (RISK_RANK[c.risk] === RISK_RANK[best.risk] &&
        RELIABILITY_RANK[c.reliability] > RELIABILITY_RANK[best.reliability])
    ) {
      best = { risk: c.risk, reliability: c.reliability };
    }
  }

  return best ?? { risk: null, reliability: null };
}
