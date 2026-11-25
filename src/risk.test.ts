import { describe, test, expect } from "bun:test";
import {
  computeOverallRisk,
  type OverallRisk,
  type RiskComponent,
  type RecoveryType,
} from "./risk.ts";

// computeOverallRisk powers /v4/product/light. The worst letter wins;
// reliability only decides between components that share that letter.
// The order was the other way round until 2026-11 (#985), so the cases
// below pin each rule down.

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
    name: "the worst letter wins over a more reliable lower one (D indicative > C established)",
    components: [cmp("d", "indicative"), cmp("c", "established")],
    recovery: null,
    expected: { risk: "d", reliability: "indicative" },
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
    name: "on the same letter the most reliable wins: established > cluster > supercluster > indicative",
    components: [
      cmp("e", "indicative"),
      cmp("e", "supercluster"),
      cmp("a", "established"),
      cmp("e", "cluster"),
    ],
    recovery: null,
    expected: { risk: "e", reliability: "cluster" },
  },
  {
    name: "established wins a tie on the worst letter",
    components: [cmp("d", "cluster"), cmp("d", "established"), cmp("b", "established")],
    recovery: null,
    expected: { risk: "d", reliability: "established" },
  },
  {
    name: "the order of the components does not matter",
    components: [cmp("c", "established"), cmp("e", "indicative"), cmp("d", "cluster")],
    recovery: null,
    expected: { risk: "e", reliability: "indicative" },
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
    name: "a worse unclassified risk wins over a better established component",
    components: [
      cmp("c", "established"),
      cmp(null, null),
      cmp(null, null),
      cmp("d", "indicative"),
    ],
    recovery: null,
    expected: { risk: "d", reliability: "indicative" },
  },
  {
    name: "a better unclassified risk does not lower the answer",
    components: [
      cmp("d", "cluster"),
      cmp(null, null),
      cmp(null, null),
      cmp("b", "indicative"),
    ],
    recovery: null,
    expected: { risk: "d", reliability: "cluster" },
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
