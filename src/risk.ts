// Derived overall-risk for /v4/product/light (issue #985).
//
// The model surfaces three independent component risks — drystand,
// bio-infection and dewatering-depth — each paired with a reliability
// label, plus the unclassified construction-year-fallback risk, which
// the caller passes in as an indicative-reliability component (#1002).
// The `light` product collapses them into one `overallRisk` plus
// its `overallRiskReliability`. The priority is _not_ "highest letter
// wins": a more reliable lower letter beats a less reliable higher one
// ("C established" > "D indicative"). Reliability rank first, then risk
// rank within the same reliability tier.
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

// Higher number = more authoritative. Ordering set by issue #985:
// established > cluster > supercluster > indicative.
const RELIABILITY_RANK: Record<Reliability, number> = {
  established: 4,
  cluster: 3,
  supercluster: 2,
  indicative: 1,
};

const RISK_RANK: Record<Risk, number> = { e: 5, d: 4, c: 3, b: 2, a: 1 };

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
      RELIABILITY_RANK[c.reliability] > RELIABILITY_RANK[best.reliability] ||
      (RELIABILITY_RANK[c.reliability] === RELIABILITY_RANK[best.reliability] &&
        RISK_RANK[c.risk] > RISK_RANK[best.risk])
    ) {
      best = { risk: c.risk, reliability: c.reliability };
    }
  }

  return best ?? { risk: null, reliability: null };
}
