import { describe, test, expect, mock, beforeEach } from "bun:test";

// The /v4/product/risk handler has no pure logic to test in isolation — it
// resolves an id, runs one SQL projection, and returns the row. The parts
// worth pinning are its control flow (the two 404 branches, the risk3
// tracker tag) and the *field contract*: risk is a strict subset of
// analysis (issue #985), and a typo'd or dropped alias is a silent,
// consumer-visible regression on a billable surface.
//
// We can't hit the real (billable) DB here, and postgres.js does the
// column→key aliasing server-side, so we mock db.sql — capturing the query
// text so we can assert the selected aliases. Geocoder resolution runs for
// real: a BAG pand id (NL.IMBAG.PAND.*) resolves to itself with no DB call,
// so it needs no stubbing. rateLimit() is a no-op without auth context (it
// short-circuits to next() when apiKeyId/tenantId are unset).

let capturedQuery = "";
let queryRows: unknown[] = [];

mock.module("../db.ts", () => ({
  sql: (strings: TemplateStringsArray, ..._values: unknown[]) => {
    capturedQuery = strings.join("");
    return Promise.resolve(queryRows);
  },
}));

const product = (await import("./product.ts")).default;

const BAG = "NL.IMBAG.PAND.0599100000654061";

// A representative model_risk_static row as the handler's SQL aliases it.
const RISK_ROW = {
  buildingId: BAG,
  foundationType: "wood",
  foundationTypeReliability: "established",
  restorationCosts: 95000,
  inquiryType: "monitoring",
  drystandRisk: "c",
  drystandReliability: "established",
  bioInfectionRisk: "b",
  bioInfectionReliability: "established",
  dewateringDepthRisk: "a",
  dewateringDepthReliability: "indicative",
  unclassifiedRisk: "d",
  recoveryType: "table",
};

beforeEach(() => {
  capturedQuery = "";
  queryRows = [];
});

describe("GET /risk/:id", () => {
  test("unresolvable id → 404 (never touches the product query)", async () => {
    const res = await product.request(`/risk/not-a-bag-id`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "Not found" });
    expect(capturedQuery).toBe(""); // bailed before the SQL ran
  });

  test("resolved id but no matching building → 404", async () => {
    queryRows = [];
    const res = await product.request(`/risk/${BAG}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "Not found" });
  });

  test("resolved id with a row → 200 and the row is returned verbatim", async () => {
    queryRows = [RISK_ROW];
    const res = await product.request(`/risk/${BAG}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RISK_ROW);
  });

  test("query targets the model_risk_static view by building_id", async () => {
    queryRows = [RISK_ROW];
    await product.request(`/risk/${BAG}`);
    expect(capturedQuery).toContain("FROM data.model_risk_static");
    expect(capturedQuery).toContain("WHERE building_id =");
  });

  // The fields added/aligned in this change (issue #985): risk must mirror
  // analysis. Pin the exact output keys so an alias typo or drift fails here.
  test("selects inquiryType and unclassifiedRisk (added to mirror analysis)", async () => {
    queryRows = [RISK_ROW];
    await product.request(`/risk/${BAG}`);
    expect(capturedQuery).toContain('AS "inquiryType"');
    expect(capturedQuery).toContain('AS "unclassifiedRisk"');
  });

  test("reliability keys are aligned to the analysis names (no *RiskReliability)", async () => {
    queryRows = [RISK_ROW];
    await product.request(`/risk/${BAG}`);
    expect(capturedQuery).toContain('AS "drystandReliability"');
    expect(capturedQuery).toContain('AS "bioInfectionReliability"');
    expect(capturedQuery).toContain('AS "dewateringDepthReliability"');
    // The pre-alignment aliases must not linger anywhere in the projection.
    expect(capturedQuery).not.toContain('RiskReliability"');
  });
});
