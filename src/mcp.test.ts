import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Two layers under test:
//  1. The MCP server itself (tool catalogue, dispatch paths, result shaping)
//     — driven through the SDK Client over an in-memory transport with a stub
//     `dispatch`, so no HTTP and no DB.
//  2. The /v4/mcp HTTP wiring in index.ts — auth gate, Streamable HTTP
//     handshake, and the in-process round trip into a real product route.
//     db.sql is mocked the same way product.test.ts does it.

let queryQueue: unknown[][] = [];
let capturedQueries: string[] = [];

mock.module("./db.ts", () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ..._values: unknown[]) => {
      capturedQueries.push(strings.join(""));
      const rows = queryQueue.length > 0 ? queryQueue.shift()! : [];
      // postgres.js queries are thenables with .catch() for fire-and-forget use.
      const p = Promise.resolve(rows);
      return p;
    },
    { end: async () => {} },
  ),
}));

const { buildMcpServer, PRODUCT_TOOLS, toToolResult, findBuilding } = await import("./mcp.ts");
const { app } = await import("./index.ts");

beforeEach(() => {
  queryQueue = [];
  capturedQueries = [];
});

const BAG = "NL.IMBAG.PAND.0599100000654061";

async function clientFor(dispatch: (path: string) => Promise<Response>) {
  const server = buildMcpServer(dispatch);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return { client, server };
}

describe("MCP server — tool catalogue", () => {
  test("exposes one tool per product route plus find_building and get_usage", async () => {
    const { client } = await clientFor(async () => Response.json({}));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [...PRODUCT_TOOLS.map((t) => t.name), "find_building", "get_usage"].sort(),
    );
    // Every product tool takes exactly one string argument `id`.
    for (const t of tools.filter((t) => t.name.startsWith("get_") && t.name !== "get_usage")) {
      expect(Object.keys(t.inputSchema.properties ?? {})).toEqual(["id"]);
    }
  });

  test("product tool paths map 1:1 onto the /v4/product routes", () => {
    expect(PRODUCT_TOOLS.map((t) => t.path)).toEqual([
      "/v4/product/analysis",
      "/v4/product/risk",
      "/v4/product/light",
      "/v4/product/facade_scan",
      "/v4/product/foundation-research",
      "/v4/product/statistics",
    ]);
  });
});

describe("MCP server — product tools dispatch in-process", () => {
  test("get_analysis forwards to /v4/product/analysis/:id and returns the body as structuredContent", async () => {
    const seen: string[] = [];
    const body = { buildingId: BAG, foundationType: "wood", unclassifiedRisk: "d" };
    const { client } = await clientFor(async (path) => {
      seen.push(path);
      return Response.json(body);
    });
    const res = await client.callTool({ name: "get_analysis", arguments: { id: BAG } });
    expect(seen).toEqual([`/v4/product/analysis/${BAG}`]);
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual(body);
    expect((res.content as { type: string; text: string }[])[0]!.text).toBe(JSON.stringify(body));
  });

  test("the id is URL-encoded on the dispatch path", async () => {
    const seen: string[] = [];
    const { client } = await clientFor(async (path) => {
      seen.push(path);
      return Response.json({});
    });
    await client.callTool({ name: "get_light", arguments: { id: "NL.IMBAG.NUMMERAANDUIDING.0599200000239714" } });
    expect(seen[0]).toBe("/v4/product/light/NL.IMBAG.NUMMERAANDUIDING.0599200000239714");
  });

  test("unrecognized id format short-circuits to identifier_invalid without dispatching", async () => {
    let dispatched = 0;
    const { client } = await clientFor(async () => {
      dispatched++;
      return Response.json({});
    });
    const res = await client.callTool({ name: "get_risk", arguments: { id: "not-a-bag-id" } });
    expect(dispatched).toBe(0);
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toStartWith("identifier_invalid:");
  });

  test("a route 404 becomes an isError result carrying the route's code", async () => {
    const { client } = await clientFor(async () =>
      Response.json(
        { code: "no_data_available", message: "Building is known, but no foundation data is available for it." },
        { status: 404 },
      ),
    );
    const res = await client.callTool({ name: "get_analysis", arguments: { id: BAG } });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toEqual({
      error: "no_data_available",
      message: "Building is known, but no foundation data is available for it.",
      status: 404,
    });
  });

  test("a route 429 surfaces Retry-After in the text", async () => {
    const { client } = await clientFor(async () =>
      Response.json(
        { code: "rate_limit_exceeded", message: "Rate limit exceeded for product 'analysis3'." },
        { status: 429, headers: { "Retry-After": "3600" } },
      ),
    );
    const res = await client.callTool({ name: "get_analysis", arguments: { id: BAG } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toContain("Retry after 3600 seconds");
  });

  test("get_usage dispatches to /v4/usage", async () => {
    const seen: string[] = [];
    const { client } = await clientFor(async (path) => {
      seen.push(path);
      return Response.json({ total: 1 });
    });
    const res = await client.callTool({ name: "get_usage", arguments: {} });
    expect(seen).toEqual(["/v4/usage"]);
    expect(res.structuredContent).toEqual({ total: 1 });
  });
});

describe("toToolResult", () => {
  test("non-JSON error body falls back to http_<status>", async () => {
    const r = await toToolResult(new Response("boom", { status: 502, statusText: "Bad Gateway" }));
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ error: "http_502", message: "Bad Gateway", status: 502 });
  });
});

describe("find_building", () => {
  test("normalises postal code + house number and queries geocoder.address", async () => {
    queryQueue = [[{ addressId: "NL.IMBAG.NUMMERAANDUIDING.0599200000239714", buildingId: BAG }]];
    const r = await findBuilding("3011 ad", "12");
    expect(capturedQueries[0]).toContain("FROM geocoder.address");
    expect(capturedQueries[0]).toContain("WHERE postal_code =");
    expect(r.matches).toHaveLength(1);
  });

  test("rejects a malformed postal code before touching the DB", async () => {
    const r = await findBuilding("12345", "1");
    expect(r).toEqual({ matches: [], error: "postal_code_invalid" });
    expect(capturedQueries).toHaveLength(0);
  });

  test("tool: empty result is an address_not_found error", async () => {
    queryQueue = [[]];
    const { client } = await clientFor(async () => Response.json({}));
    const res = await client.callTool({ name: "find_building", arguments: { postalCode: "3011AD", houseNumber: "9999" } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toStartWith("address_not_found:");
  });
});

// --- HTTP wiring -----------------------------------------------------------

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  },
};

function rpc(body: unknown, auth?: string) {
  return app.request("/v4/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(auth ? { Authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });
}

// Parse a Streamable HTTP response: either plain JSON or an SSE stream
// whose last `data:` line is the JSON-RPC response.
async function rpcResult(res: Response): Promise<any> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text.split("\n").filter((l) => l.startsWith("data:")).pop()!;
    return JSON.parse(data.slice(5));
  }
  return JSON.parse(text);
}

const KEY_ROW = [{ api_key_id: "k1", user_id: "u1", organization_id: "org1", source: "ba" }];

describe("POST /v4/mcp", () => {
  test("without an API key → the normal JSON 401, no MCP handshake", async () => {
    const res = await rpc(INIT);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "missing_api_key" });
  });

  test("with an invalid key → 401 invalid_api_key", async () => {
    queryQueue = [[]]; // resolveKey miss
    const res = await rpc(INIT, "Bearer fmsk.nope");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "invalid_api_key" });
  });

  test("initialize → server info, plain JSON, no session header (stateless)", async () => {
    queryQueue = [KEY_ROW, []];
    const res = await rpc(INIT, "Bearer fmsk.valid-a");
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    expect(res.headers.get("content-type")).toContain("application/json");
    const out = await rpcResult(res);
    expect(out.result.serverInfo.name).toBe("fundermaps-webservice");
    expect(out.result.instructions).toContain("FunderMaps");
  });

  test("tools/call round-trips in-process into the real /v4/product/risk route with the caller's key", async () => {
    const riskRow = {
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
    // Query order: outer auth (cache miss) → fire-and-forget last_request
    // UPDATE → inner auth is a cache hit for the same key → rateLimit config
    // lookup (none) → product query → tracker insert.
    queryQueue = [KEY_ROW, [], [], [riskRow], []];
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_risk", arguments: { id: BAG } },
      },
      "Bearer fmsk.valid-b",
    );
    expect(res.status).toBe(200);
    const out = await rpcResult(res);
    expect(out.result.isError).toBeFalsy();
    expect(out.result.structuredContent).toEqual(riskRow);
    // The billable route ran for real: its tracker insert hit the (mocked) DB.
    expect(capturedQueries.some((q) => q.includes("INSERT INTO application.product_tracker"))).toBe(true);
    expect(capturedQueries.some((q) => q.includes("FROM data.model_risk_static"))).toBe(true);
  });

  test("GET /v4/mcp (SSE stream) is refused — stateless server", async () => {
    queryQueue = [KEY_ROW, []];
    const res = await app.request("/v4/mcp", {
      method: "GET",
      headers: { Authorization: "Bearer fmsk.valid-c", Accept: "text/event-stream" },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32000);
  });
});
