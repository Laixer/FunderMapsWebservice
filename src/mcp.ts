// MCP (Model Context Protocol) surface over the /v4 product API.
//
// `POST /v4/mcp` is a stateless Streamable-HTTP MCP endpoint. Every tool is a
// thin wrapper around an existing /v4 route: the tool handler dispatches an
// in-process request (Hono `app.request()`, no network hop) to the same route
// with the caller's own `Authorization: Bearer` header. That means auth (and
// its 60s cache), `product_tracker` billing, dedup and per-key rate limits all
// run exactly as they do for a REST call — an agent calling `get_analysis` is
// indistinguishable from a curl to `/v4/product/analysis/:id` in the billing
// data. No SQL is duplicated here; the only query this file owns is the
// (free, untracked) address → building lookup in `find_building`.
//
// Stateless on purpose: one McpServer + transport per request, no session
// ids, no SSE keep-alive — nothing for App Platform's idle timeout to kill.

import type { Context } from "hono";
import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sql } from "./db.ts";
import { clampId } from "./errors.ts";
import { detectFormat } from "./geocoder.ts";
import type { AppEnv } from "./index.ts";

export const MCP_SERVER_NAME = "fundermaps-webservice";
export const MCP_SERVER_VERSION = "4.0.0";

/** Performs an in-process GET against the app, carrying the caller's auth. */
export type Dispatch = (path: string) => Promise<Response>;

const ID_DESCRIPTION =
  "Building or address identifier. Accepted: BAG pand `NL.IMBAG.PAND.{16 digits}`, " +
  "BAG nummeraanduiding `NL.IMBAG.NUMMERAANDUIDING.{16 digits}`, or the legacy 16-digit " +
  "forms. Use `find_building` first if you only have a postal code + house number.";

interface ProductTool {
  name: string;
  title: string;
  path: string;
  description: string;
}

// One tool per billable product route. `path` is the /v4 route prefix the
// tool forwards to; the product string billed is whatever that route sets.
export const PRODUCT_TOOLS: readonly ProductTool[] = [
  {
    name: "get_analysis",
    title: "Full foundation analysis",
    path: "/v4/product/analysis",
    description:
      "Full foundation risk analysis for one building: foundation type, construction year, " +
      "drystand / bio-infection / dewatering-depth risks with reliability, restoration cost " +
      "estimate, recovery type, subsidence velocity, address count. Billable (product `analysis3`).",
  },
  {
    name: "get_risk",
    title: "Foundation risk (valuation subset)",
    path: "/v4/product/risk",
    description:
      "Subset of `get_analysis` aimed at valuation chains and dashboards: foundation type, the " +
      "three risk classes with reliability, restoration costs, recovery type. Billable (`risk3`).",
  },
  {
    name: "get_light",
    title: "Overall foundation risk (single verdict)",
    path: "/v4/product/light",
    description:
      "Minimal output with one derived `overallRisk` letter (a–e) for the building, plus the " +
      "fields it was derived from. Use when you need a single answer. Billable (`light3`).",
  },
  {
    name: "get_facade_scan",
    title: "Façade scan outcome",
    path: "/v4/product/facade_scan",
    description:
      "Outcome of the most recent FunderMaps façade scan (QuickScan) for the building within the " +
      "last 3 years, if any: observed damage and the resulting façade risk. Billable (`facade_scan4`).",
  },
  {
    name: "get_foundation_research",
    title: "Foundation research outcome",
    path: "/v4/product/foundation-research",
    description:
      "Outcome of the most recent documented foundation research (funderingsonderzoek) for the " +
      "building, if any: type, damage cause, recovery advice, contractor. Billable (`foundation_research4`).",
  },
  {
    name: "get_statistics",
    title: "Neighbourhood statistics",
    path: "/v4/product/statistics",
    description:
      "Aggregate foundation statistics for the CBS neighbourhood (`BU{8 digits}`) that contains " +
      "the given building or address, or for a neighbourhood id directly: foundation type, " +
      "construction year and risk distributions, incident / inquiry / recovery counts per year. " +
      "Billable (`statistics3`).",
  },
];

interface ErrorBody {
  code?: string;
  message?: string;
}

// Turns a /v4 response into an MCP tool result. 200 → the JSON body as both
// human-readable text and `structuredContent`; anything else → `isError` with
// the route's structured `code` + `message` so the model can pick a follow-up
// (wrong id vs. no data vs. rate limited) without parsing prose.
export async function toToolResult(res: Response) {
  const body = (await res.json().catch(() => null)) as unknown;
  if (res.ok) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(body) }],
      structuredContent: body as Record<string, unknown>,
    };
  }
  const err = (body ?? {}) as ErrorBody;
  const code = err.code ?? `http_${res.status}`;
  const message = err.message ?? res.statusText;
  const retryAfter = res.headers.get("Retry-After");
  const text =
    res.status === 429 && retryAfter
      ? `${code}: ${message} Retry after ${retryAfter} seconds.`
      : `${code}: ${message}`;
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
    structuredContent: { error: code, message, status: res.status },
  };
}

// Free (untracked) address lookup so an agent holding "3011AD 12" can get to a
// BAG pand id. geocoder.address.building_id already stores the pand external
// id, and address_postal_code_idx makes this one index scan.
export async function findBuilding(postalCode: string, houseNumber: string) {
  const pc = postalCode.replaceAll(" ", "").toUpperCase();
  const nr = houseNumber.replaceAll(" ", "").toLowerCase();
  if (!/^\d{4}[A-Z]{2}$/.test(pc)) {
    return { matches: [], error: "postal_code_invalid" as const };
  }
  const rows = await sql`
    SELECT
      external_id  AS "addressId",
      building_id  AS "buildingId",
      street,
      building_number AS "houseNumber",
      postal_code  AS "postalCode",
      city
    FROM geocoder.address
    WHERE postal_code = ${pc}
      AND (lower(building_number) = ${nr} OR lower(building_number) LIKE ${nr + "%"})
    ORDER BY (lower(building_number) = ${nr}) DESC, building_number
    LIMIT 20
  `;
  return { matches: rows as Record<string, unknown>[] };
}

export function buildMcpServer(dispatch: Dispatch): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      instructions:
        "FunderMaps: foundation (fundering) data for buildings in the Netherlands. Identify a " +
        "building by BAG id; if you only have an address, call `find_building` first. Product " +
        "tools are billed per building per 24h, identical to the REST API — prefer `get_light` " +
        "for a single verdict and `get_analysis` when you need the underlying fields. " +
        "Risk letters run a (lowest) to e (highest). `reliability` tells you how the value was " +
        "established: `established` = measured on this building, `indicative` = modelled.",
    },
  );

  server.registerTool(
    "find_building",
    {
      title: "Find building by postal code + house number",
      description:
        "Resolve a Dutch postal code (e.g. `3011AD`) and house number (e.g. `12` or `25bis`) to " +
        "BAG address and building identifiers. Returns up to 20 matches (exact house number " +
        "first). Free — not a billable product call.",
      inputSchema: {
        postalCode: z.string().min(6).max(7).describe("Dutch postal code, e.g. 3011AD or 3011 AD"),
        houseNumber: z.string().min(1).max(16).describe("House number incl. suffix, e.g. 12, 25bis, 15a"),
      },
    },
    async ({ postalCode, houseNumber }) => {
      const result = await findBuilding(postalCode, houseNumber);
      if ("error" in result) {
        return {
          isError: true,
          content: [{ type: "text", text: `${result.error}: '${clampId(postalCode)}' is not a Dutch postal code.` }],
        };
      }
      if (result.matches.length === 0) {
        return {
          isError: true,
          content: [{ type: "text", text: `address_not_found: no BAG address at ${postalCode} ${houseNumber}.` }],
          structuredContent: { matches: [] },
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result.matches) }],
        structuredContent: { matches: result.matches },
      };
    },
  );

  for (const tool of PRODUCT_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: {
          id: z.string().min(1).max(64).describe(
            tool.name === "get_statistics"
              ? ID_DESCRIPTION + " Also accepts a CBS neighbourhood id `BU{8 digits}`."
              : ID_DESCRIPTION,
          ),
        },
      },
      async ({ id }) => {
        // Cheap pre-check so a garbage id never reaches the route (the route
        // would 404 anyway; this just saves the in-process round-trip).
        if (detectFormat(id) === "unknown") {
          return {
            isError: true,
            content: [{ type: "text", text: `identifier_invalid: '${clampId(id)}' is not a recognized identifier format.` }],
            structuredContent: { error: "identifier_invalid", status: 404 },
          };
        }
        const res = await dispatch(`${tool.path}/${encodeURIComponent(id)}`);
        return toToolResult(res);
      },
    );
  }

  server.registerTool(
    "get_usage",
    {
      title: "API usage for your organisation",
      description:
        "Billable product calls made by your organisation: per day (last 30 days), per month " +
        "(this year) and total. Free.",
      inputSchema: {},
    },
    async () => toToolResult(await dispatch("/v4/usage")),
  );

  return server;
}

/**
 * Hono handler for `/v4/mcp`. Must run behind `authMiddleware` so that an
 * unauthenticated caller gets the normal JSON 401 instead of an MCP handshake;
 * the validated bearer is then forwarded verbatim on every in-process dispatch.
 */
export function mcpHandler(app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }) {
  return async (c: Context<AppEnv>) => {
    // Stateless means POST only: there is no session to resume over GET/SSE
    // and nothing to DELETE. Answer the way the MCP spec suggests (405 +
    // JSON-RPC error) instead of letting the transport open a stream.
    if (c.req.method !== "POST") {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed. This MCP endpoint is stateless: POST only." },
          id: null,
        },
        405,
        { Allow: "POST" },
      );
    }

    const authorization = c.req.header("Authorization") ?? "";
    const dispatch: Dispatch = async (path) =>
      app.request(path, { headers: { Authorization: authorization } });

    const server = buildMcpServer(dispatch);
    const transport = new StreamableHTTPTransport({
      sessionIdGenerator: undefined, // stateless: no session id, no resumption
      enableJsonResponse: true, // one JSON body per POST, no SSE stream to keep open
    });
    await server.connect(transport);
    try {
      return (await transport.handleRequest(c)) ?? c.body(null, 204);
    } finally {
      // Safe here only because enableJsonResponse makes handleRequest resolve
      // with the complete body; with SSE the stream would still be writing.
      await server.close().catch(() => {});
    }
  };
}
