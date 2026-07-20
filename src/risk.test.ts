import { describe, test, expect } from "bun:test";
import {
  computeOverallRisk,
  type OverallRisk,
  type RiskComponent,
  type RecoveryType,
} from "./risk.ts";

// computeOverallRisk powers /v4/product/light. Subtle priority rules —
// reliability tier outranks raw risk letter — make this a likely place
// for regressions to hide, so the cases below cover each rule the issue
// pins down (#985).

function cmp(
  risk: RiskComponent["risk"],
  reliability: RiskComponent["reliability"],
): RiskComponent {
  return { risk, reliability };
}

const cases: {
  name: string;
  components: RiskComponent[];
  recovery: RecoveryType | null;
  expected: OverallRisk;
}[] = [
  {
    name: "single component wins by default",
    components: [cmp("c", "established")],
    recovery: null,
    expected: { risk: "c", reliability: "established" },
  },
  {
    name: "established C beats indicative D (issue example: C vastgesteld > D indicatief)",
    components: [cmp("d", "indicative"), cmp("c", "established")],
    recovery: null,
    expected: { risk: "c", reliability: "established" },
  },
  {
    name: "within the same reliability, higher risk letter wins (E > D > C)",
    components: [
      cmp("c", "cluster"),
      cmp("e", "cluster"),
      cmp("d", "cluster"),
    ],
    recovery: null,
    expected: { risk: "e", reliability: "cluster" },
  },
  {
    name: "reliability rank: established > cluster > supercluster > indicative",
    components: [
      cmp("e", "indicative"),
      cmp("e", "supercluster"),
      cmp("a", "established"),
      cmp("e", "cluster"),
    ],
    recovery: null,
    expected: { risk: "a", reliability: "established" },
  },
  {
    name: "supercluster beats indicative even on equal risk",
    components: [cmp("d", "indicative"), cmp("d", "supercluster")],
    recovery: null,
    expected: { risk: "d", reliability: "supercluster" },
  },
  {
    name: "components without reliability are skipped",
    components: [cmp("e", null), cmp("c", "indicative")],
    recovery: null,
    expected: { risk: "c", reliability: "indicative" },
  },
  {
    name: "components without risk are skipped",
    components: [cmp(null, "established"), cmp("b", "indicative")],
    recovery: null,
    expected: { risk: "b", reliability: "indicative" },
  },
  {
    name: "all-null components → null overall risk",
    components: [cmp(null, null), cmp(null, "indicative"), cmp("e", null)],
    recovery: null,
    expected: { risk: null, reliability: null },
  },
  {
    name: "empty components list → null overall risk",
    components: [],
    recovery: null,
    expected: { risk: null, reliability: null },
  },
  {
    name: "fallback-only building: unclassified risk as indicative component wins over all-null components (#1002)",
    components: [
      cmp(null, null),
      cmp(null, null),
      cmp(null, null),
      cmp("d", "indicative"),
    ],
    recovery: null,
    expected: { risk: "d", reliability: "indicative" },
  },
  {
    name: "real component outranks the indicative unclassified fallback (#1002)",
    components: [
      cmp("c", "established"),
      cmp(null, null),
      cmp(null, null),
      cmp("d", "indicative"),
    ],
    recovery: null,
    expected: { risk: "c", reliability: "established" },
  },
  {
    name: "recovery override beats any worse model risk",
    components: [cmp("e", "established"), cmp("e", "established")],
    recovery: "beam_on_pile",
    expected: { risk: "a", reliability: "established" },
  },
  {
    name: "recovery override applies for `unknown` recovery type",
    components: [cmp("e", "established")],
    recovery: "unknown",
    expected: { risk: "a", reliability: "established" },
  },
  {
    name: "recovery override applies even when all components are null",
    components: [cmp(null, null)],
    recovery: "injection",
    expected: { risk: "a", reliability: "established" },
  },
];

describe("computeOverallRisk", () => {
  for (const { name, components, recovery, expected } of cases) {
    test(name, () => {
      expect(computeOverallRisk(components, recovery)).toEqual(expected);
    });
  }
});
