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
// When set, each sql call consumes the next entry instead of queryRows —
// needed for flows that issue multiple, differently-shaped queries
// (address resolution → product query → miss classification).
let queryQueue: unknown[][] = [];

mock.module("../db.ts", () => ({
  sql: (strings: TemplateStringsArray, ..._values: unknown[]) => {
    capturedQuery = strings.join("");
    return Promise.resolve(queryQueue.length > 0 ? queryQueue.shift() : queryRows);
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
  queryQueue = [];
});

describe("GET /risk/:id", () => {
  test("unrecognized id format → 404 identifier_invalid (never touches the product query)", async () => {
    const res = await product.request(`/risk/not-a-bag-id`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("identifier_invalid");
    expect(body.message).toContain("not-a-bag-id");
    expect(capturedQuery).toBe(""); // bailed before the SQL ran
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

// The 404 reason split for issue Laixer/FunderMaps#1002: consumers must be
// able to pick the follow-up step (resubmit corrected address / request a
// QuickScan / do nothing) from `code` alone. Exercised through the /risk
// handler with the real geocoder against the mocked db; the same
// resolutionError path serves analysis and light.
describe("GET /risk/:id — 404 reason codes (issue #1002)", () => {
  const ADDRESS = "NL.IMBAG.NUMMERAANDUIDING.0599200000654061";

  test("pand id unknown in BAG → building_not_found", async () => {
    // product query misses, then geocoder.building lookup misses too
    queryQueue = [[], []];
    const res = await product.request(`/risk/${BAG}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("building_not_found");
    expect(body.message).toContain(BAG);
    // The classification query ran against geocoder.building.
    expect(capturedQuery).toContain("FROM geocoder.building");
  });

  test("pand known but no data row → no_data_available (the QuickScan case)", async () => {
    queryQueue = [[], [{ building_type: "house" }]];
    const res = await product.request(`/risk/${BAG}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("no_data_available");
    expect(body.message).toContain(BAG);
  });

  test("address resolving to a ligplaats → not_a_building (no classification query needed)", async () => {
    queryQueue = [[{ building_id: "NL.IMBAG.LIGPLAATS.0599020000123456" }]];
    const res = await product.request(`/risk/${ADDRESS}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("not_a_building");
    // Bailed at resolution: the last query was the address lookup, not
    // the product query or geocoder.building.
    expect(capturedQuery).toContain("FROM geocoder.address");
  });

  test("address resolving to a standplaats → not_a_building", async () => {
    queryQueue = [[{ building_id: "NL.IMBAG.STANDPLAATS.0599030000123456" }]];
    const res = await product.request(`/risk/${ADDRESS}`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("not_a_building");
  });

  test("unknown address → address_not_found", async () => {
    queryQueue = [[]];
    const res = await product.request(`/risk/${ADDRESS}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("address_not_found");
    expect(body.message).toContain(ADDRESS);
  });

  test("address resolving to a pand with a data row → 200", async () => {
    queryQueue = [[{ building_id: BAG }], [RISK_ROW]];
    const res = await product.request(`/risk/${ADDRESS}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RISK_ROW);
  });
});
