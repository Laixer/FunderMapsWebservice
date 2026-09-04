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

// The research endpoints sign a link to the source document (issue
// Laixer/FunderMapsApi#140). The process-wide linker reads S3_* from the
// environment, which CI does not set — so swap in one built from dummy
// credentials. Presigning is local (no network), so the real signing code
// runs; the omit-vs-present decision is what these tests pin.
const { createDocumentLinker } = await import("../document.ts");
mock.module("../document.ts", () => ({
  sourceDocumentResource: createDocumentLinker({
    endpoint: "https://ams3.digitaloceanspaces.com",
    region: "us-east-1",
    bucket: "fundermaps",
    accessKeyId: "AKIATEST",
    secretAccessKey: "secret",
  }),
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

// Issue Laixer/FunderMaps#1010: /light is the single verdict and nothing
// else. restorationCosts and drystandRisk were dropped from the response;
// the component risks stay in the SQL only as computeOverallRisk inputs.
describe("GET /light/:id", () => {
  const LIGHT_ROW = {
    drystandRisk: "c",
    drystandRiskReliability: "established",
    bioInfectionRisk: "b",
    bioInfectionRiskReliability: "established",
    dewateringDepthRisk: "a",
    dewateringDepthRiskReliability: "indicative",
    recoveryType: "table",
  };

  test("response carries exactly overallRisk + overallRiskReliability", async () => {
    queryRows = [LIGHT_ROW];
    const res = await product.request(`/light/${BAG}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["overallRisk", "overallRiskReliability"]);
    // recoveryType set → forced to a, established.
    expect(body).toEqual({ overallRisk: "a", overallRiskReliability: "established" });
  });

  test("restoration_costs is no longer selected; component risks still are", async () => {
    queryRows = [LIGHT_ROW];
    await product.request(`/light/${BAG}`);
    expect(capturedQuery).not.toContain("restoration_costs");
    expect(capturedQuery).toContain('AS "drystandRisk"');
    expect(capturedQuery).toContain('AS "bioInfectionRisk"');
    expect(capturedQuery).toContain('AS "dewateringDepthRisk"');
  });
});

// Issue Laixer/FunderMapsApi#140: `resource` = signed link to the source
// document. Rule A: freshness == the endpoint's data window (3 y / 5 y), so
// there is no "document too old" case to test — if the row is served, the
// link is there. No document on file → the key is ABSENT, never null.
describe("research endpoints — source document `resource` (#140)", () => {
  const DOC = "8286ef68-9217-4508-b9e2-6d3e9c5a18da.pdf";
  const RESEARCH_ROW = {
    buildingId: BAG,
    inquiryId: 4711,
    inquiryType: "foundation_research",
    documentDate: "2024-03-01",
    validUntil: "2029-03-01",
    documentFile: DOC,
    settlementSpeed: "small",
    skewedParallelFacade: null,
    skewedPerpendicularFacade: null,
    facadeCrack: "nil",
    overallQuality: "mediocre",
    recoveryAdvised: true,
    enforcementTerm: "term510",
    contractor: "Bureau X",
    facadeScanRisk: null,
  };

  test("the research query selects document_file", async () => {
    queryRows = [RESEARCH_ROW];
    await product.request(`/foundation-research/${BAG}`);
    expect(capturedQuery).toContain('i.document_file AS "documentFile"');
    expect(capturedQuery).toContain("FROM report.inquiry i");
  });

  test("foundation-research: document on file → resource with a 1 h presigned URL", async () => {
    queryRows = [RESEARCH_ROW];
    const res = await product.request(`/foundation-research/${BAG}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.resource).toBeDefined();
    const resource = body.resource as { url: string; expiresAt: string; mediaType: string };
    const url = new URL(resource.url);
    expect(url.pathname).toBe(`/fundermaps/inquiry-report/${DOC}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(resource.mediaType).toBe("application/pdf");
    expect(Date.parse(resource.expiresAt)).toBeGreaterThan(Date.now());
    // The storage name itself is never exposed as a top-level field.
    expect("documentFile" in body).toBe(false);
  });

  test("facade_scan: document on file → resource present", async () => {
    queryRows = [{ ...RESEARCH_ROW, inquiryType: "facade_scan", facadeScanRisk: "c" }];
    const res = await product.request(`/facade_scan/${BAG}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.facadeScanRisk).toBe("c");
    expect((body.resource as { url: string }).url).toContain(`inquiry-report/${DOC}`);
    expect("documentFile" in body).toBe(false);
  });

  test("no document on file → `resource` key is omitted entirely (not null)", async () => {
    for (const documentFile of [null, "", "file"]) {
      queryRows = [{ ...RESEARCH_ROW, documentFile }];
      const fr = await product.request(`/foundation-research/${BAG}`);
      expect(fr.status).toBe(200);
      const frBody = (await fr.json()) as Record<string, unknown>;
      expect("resource" in frBody).toBe(false);

      queryRows = [{ ...RESEARCH_ROW, documentFile, inquiryType: "facade_scan" }];
      const fs = await product.request(`/facade_scan/${BAG}`);
      expect(fs.status).toBe(200);
      const fsBody = (await fs.json()) as Record<string, unknown>;
      expect("resource" in fsBody).toBe(false);
    }
  });

  test("the rest of the contract is unchanged by the new field", async () => {
    queryRows = [RESEARCH_ROW];
    const res = await product.request(`/foundation-research/${BAG}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        "buildingId",
        "inquiryId",
        "inquiryType",
        "documentDate",
        "validUntil",
        "settlementSpeed",
        "skewedParallelFacade",
        "skewedPerpendicularFacade",
        "facadeCrack",
        "overallQuality",
        "recoveryAdvised",
        "enforcementTerm",
        "contractor",
        "resource",
      ].sort(),
    );
  });
});
