# FunderMaps Product API — v4 reference

The FunderMaps webservice serves building-level foundation data to integrators: valuation chains, banks, insurers and municipalities. This document is the complete contract of the current version, **v4**. Anything not listed here is not part of the contract; if a response differs from what is documented, treat it as a defect and report it to us.

```
Production   https://ws.fundermaps.com/v4/...
Staging      https://ws-staging.fundermaps.com/v4/...
```

Staging serves the same production data with the same API key and is meant for trying an integration before pointing production traffic at it. Calls on either hostname are billed.

The previous version, `/api/v3`, was switched off on 2026-08-29 and now returns `404`. If you are migrating an old v3 client, see [Appendix: coming from v3](#appendix-coming-from-v3).

## 1. Endpoints

| Endpoint | Returns | Billed as |
|----------|---------|-----------|
| `GET /v4/product/analysis/{id}` | Full model-based assessment of one building — [field reference](#3-analysis-response-reference) | `analysis3` |
| `GET /v4/product/risk/{id}` | Subset of `analysis` for valuation chains and dashboards | `risk3` |
| `GET /v4/product/light/{id}` | One derived `overallRisk` + reliability | `light3` |
| `GET /v4/product/facade_scan/{id}` | Outcome of the most recent facade scan (QuickScan), if under 3 years old | `facade_scan4` |
| `GET /v4/product/foundation-research/{id}` | Outcome of the most recent foundation research, if under 5 years old | `foundation_research4` |
| `GET /v4/product/statistics/{id}` | Aggregates for the neighborhood of a building or a CBS neighborhood — [shape](#4-statistics-response) | `statistics3` |
| `GET /v4/usage` | Your organization's billed-event counts (last 30 days per day, this year per month, all-time total) | free |
| `GET /v4/health` | Availability probe, unauthenticated — [details](#7-health-check) | free |
| `POST /v4/mcp` | The same products as an MCP server for AI agents — [details](#mcp-endpoint-for-ai-agents) | per tool |

Billing counts **billable events**: one event per (product, building) per 24 hours, regardless of how often you request it. Per-product usage limits may apply to your key; see [rate limits](#5-error-responses).

### Accepted `{id}` formats

| Endpoint | Accepted formats |
|----------|------------------|
| `/v4/product/analysis/{id}` | BAG pand (`NL.IMBAG.PAND.0599100000369041` or 16-digit `0599100000369041`); BAG nummeraanduiding (`NL.IMBAG.NUMMERAANDUIDING.0599200000123456` or 16-/15-digit bare form) |
| `/v4/product/risk/{id}` | Same as `analysis` |
| `/v4/product/light/{id}` | Same as `analysis` |
| `/v4/product/facade_scan/{id}` | Same as `analysis` |
| `/v4/product/foundation-research/{id}` | Same as `analysis` |
| `/v4/product/statistics/{id}` | Any of the above, plus CBS neighborhood (`BU03630000`) |

Nummeraanduiding IDs are resolved to their pand before lookup. BAG address-to-building is many-to-one, so two nummeraanduidingen on the same pand return identical analysis and statistics — that's expected, the model is building-level.

Unrecognized or unresolvable IDs return a `404` with a structured error body — see [Error responses](#5-error-responses).

### `/v4/product/risk` and `/v4/product/light`

**`/v4/product/risk/{id}`** — a subset of `analysis` for valuation chains and dashboards. Returns: `buildingId`, `foundationType`, `foundationTypeReliability`, `restorationCosts`, `inquiryType`, `drystandRisk`, `drystandReliability`, `bioInfectionRisk`, `bioInfectionReliability`, `dewateringDepthRisk`, `dewateringDepthReliability`, `unclassifiedRisk`, `recoveryType`.

Field names and semantics are identical to the corresponding fields in `analysis` — note that the reliability fields are `drystandReliability`, `bioInfectionReliability` and `dewateringDepthReliability` (not `…RiskReliability`).

**`/v4/product/light/{id}`** — minimal response for fast integrations. Collapses the three component risks plus `unclassifiedRisk` (the construction-year-derived fallback classification) into a single derived `overallRisk` + `overallRiskReliability`. The fallback enters at `indicative` reliability, so it only determines `overallRisk` when no more reliable component risk is present — buildings covered only by the fallback report that class instead of `null`. If a `recoveryType` is set on the building (i.e. the foundation has been restored), `overallRisk` is forced to `a` with `established` reliability. Returns: `overallRisk`, `overallRiskReliability` — nothing else (`restorationCosts` and `drystandRisk` were removed from the response per Laixer/FunderMaps#1010).

### Research outcome endpoints

Where `analysis` returns the **model-based** risk assessment, these two endpoints return the summarized outcome of **actually performed research** on the building, where available. They complement `analysis`; they do not replace it.

**`/v4/product/facade_scan/{id}`** — the most recent facade scan (QuickScan) for the building, provided its report is **less than 3 years old**. Returns: `buildingId`, `inquiryId`, `inquiryType` (`facade_scan`), `documentDate` (`YYYY-MM-DD`), `validUntil` (`documentDate` + 3 years), `facadeScanRisk` (`a`–`e`), `settlementSpeed`, `skewedParallelFacade`, `skewedPerpendicularFacade`, `facadeCrack`, `contractor`, `resource` (optional, see below).

**`/v4/product/foundation-research/{id}`** — the most recent foundation research for the building, provided its report is **less than 5 years old**. Returns: `buildingId`, `inquiryId`, `inquiryType` (`foundation_research`), `documentDate`, `validUntil` (`documentDate` + 5 years), `settlementSpeed`, `skewedParallelFacade`, `skewedPerpendicularFacade`, `facadeCrack`, `overallQuality`, `recoveryAdvised` (boolean), `enforcementTerm`, `contractor`, `resource` (optional, see below).

Notes for both:

- All fields are nullable except `buildingId`. A `null` means the underlying report did not record that observation.
- **`resource` — the source document.** A link to the original report (normally a PDF) the outcome was taken from:

  ```json
  "resource": {
    "url": "https://ams3.digitaloceanspaces.com/…/inquiry-report/8286ef68-….pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&…",
    "expiresAt": "2026-09-04T13:00:00.000Z",
    "mediaType": "application/pdf"
  }
  ```

  - `url` is a **signed, short-lived link**: it works for **1 hour** from the moment of the response (`expiresAt`, ISO-8601 UTC), for anyone who holds it, with no further authentication. Fetch the document promptly; do not persist the URL — re-request the product to get a fresh one. Retrieving the document is not a separate billable call.
  - **Freshness follows the data window.** The link is included whenever the record itself is served: within 3 years for `facade_scan`, within 5 years for `foundation-research`. There is no separate age limit on the document.
  - **Absent, never `null`.** When the record has no source document on file, the `resource` key is **omitted from the response entirely**. Check for presence (`"resource" in body`), not for `null`.
  - `mediaType` is almost always `application/pdf`; a handful of legacy dossiers hold an image instead.
- Building-level: a nummeraanduiding resolves to its pand first, so two addresses on the same building return the same outcome — the research is attached to the building, not to one address.
- "Latest available" = the newest report by `documentDate` of that research type within the freshness window. A building whose only research is older than the window returns `404 no_data_available`, same as a building never researched.
- The skew/settlement classifications use the same scale (`nil` → `very_big`) and derivation as the public facade-scan map layer; `facadeCrack` is the worst of the four facade crack observations.

Same authentication, ID formats, and error responses as `analysis`.

### MCP endpoint for AI agents

`POST /v4/mcp` exposes the same products as an [MCP](https://modelcontextprotocol.io) server (Streamable HTTP, stateless, JSON responses), so an AI agent — Claude, ChatGPT, an in-house LLM tool — can call FunderMaps directly with your existing API key. Nothing else changes: the same `Authorization: Bearer fmsk.…` header, the same billing (a tool call is recorded as the corresponding product, with the same 24-hour deduplication), the same rate limits and the same error codes.

Tools:

| Tool | Equivalent REST call | Billed as |
|---|---|---|
| `find_building` (`postalCode`, `houseNumber`) | — (address → BAG id lookup) | free |
| `get_analysis` (`id`) | `GET /v4/product/analysis/{id}` | `analysis3` |
| `get_risk` (`id`) | `GET /v4/product/risk/{id}` | `risk3` |
| `get_light` (`id`) | `GET /v4/product/light/{id}` | `light3` |
| `get_facade_scan` (`id`) | `GET /v4/product/facade_scan/{id}` | `facade_scan4` |
| `get_foundation_research` (`id`) | `GET /v4/product/foundation-research/{id}` | `foundation_research4` |
| `get_statistics` (`id`) | `GET /v4/product/statistics/{id}` | `statistics3` |
| `get_usage` | `GET /v4/usage` | free |

Connecting (Claude Desktop / Claude Code / any Streamable-HTTP client):

```json
{
  "mcpServers": {
    "fundermaps": {
      "type": "http",
      "url": "https://ws.fundermaps.com/v4/mcp",
      "headers": { "Authorization": "Bearer fmsk.your-key" }
    }
  }
}
```

Tool results carry the REST JSON body both as text and as `structuredContent`; a non-200 REST response becomes a tool error whose text starts with the REST `code` (`no_data_available`, `rate_limit_exceeded`, …) so the agent can pick the same follow-up a REST consumer would. The endpoint is POST-only: `GET`/`DELETE` return `405` because there are no sessions to resume or terminate.

## 2. Authentication

Every product call carries your API key as a standard Bearer token:

```
Authorization: Bearer fmsk.your_api_key
```

No other delivery method (query parameter, custom header) is accepted. Keys are issued by FunderMaps; contact us to add or rotate a key.

## 3. Analysis response reference

The complete field set of `GET /v4/product/analysis/{id}`. Nothing else is returned; any field not listed here is not part of the contract.

"Null share" is the proportion of the 11.2M buildings in the current model snapshot for which the field is `null`. It is guidance for sizing your handling of missing data, not a contract — shares move as the model is rebuilt.

| Field | Type | Null share | Notes |
|-------|------|-----------|-------|
| `buildingId` | string | never | BAG pand id, e.g. `NL.IMBAG.PAND.0599100000369041` |
| `neighborhoodId` | string | <0.1% | Internal FunderMaps neighborhood id, not a CBS `BU*` code |
| `constructionYear` | integer | <0.1% | Year, not a date |
| `constructionYearReliability` | `reliability` | never | |
| `foundationType` | `foundationType` | never | |
| `foundationTypeReliability` | `reliability` | never | |
| `restorationCosts` | number | 43% | Euro estimate for the whole building; divide by `addressCount` for a per-object figure |
| `height` | number | never | Metres |
| `velocity` | number | 90% | Subsidence rate, mm/year; negative = sinking |
| `groundWaterLevel` | number | 10% | |
| `groundLevel` | number | 9% | |
| `soil` | string | 10% | Free-text soil description, not an enum |
| `surfaceArea` | number | never | m² |
| `damageCause` | `damageCause` | >99% | Only set where a report recorded a cause |
| `inquiryType` | `inquiryType` | 97% | Type of the report backing this building, where one exists |
| `drystand` | number | 96% | |
| `drystandRisk` | `foundationRisk` | 53% | |
| `drystandReliability` | `reliability` | never | |
| `bioInfectionRisk` | `foundationRisk` | 97% | |
| `bioInfectionReliability` | `reliability` | never | |
| `dewateringDepth` | number | 47% | |
| `dewateringDepthRisk` | `foundationRisk` | 4% | |
| `dewateringDepthReliability` | `reliability` | never | |
| `unclassifiedRisk` | `foundationRisk` | 99% | See §6 |
| `recoveryType` | `recoveryType` | >99% | Set when the foundation has been restored |
| `addressCount` | integer | never | Addresses (nummeraanduidingen) on this pand; divide `restorationCosts` by it for a per-object figure |

Note the asymmetry in the reliability field names: `constructionYearReliability` and `foundationTypeReliability` are named after their value field, while `drystandReliability`, `bioInfectionReliability` and `dewateringDepthReliability` are **not** `…RiskReliability`. This matches v3 exactly; it is a quirk we preserved deliberately rather than a v4 change.

The `*Reliability` fields have never been `null` in any model snapshot to date, but treat them as nullable anyway — v3's non-nullable integer encoding could not express "unknown", and v4's can.

## 4. Statistics response

`GET /v4/product/statistics/{id}` returns aggregates for the neighborhood the building lies in (or for the CBS neighborhood given directly).

| Field | Shape |
|-------|-------|
| `foundationTypeDistribution` | `[{ "foundationType": "concrete", "percentage": 81.01 }, …]` |
| `constructionYearDistribution` | `[{ "yearFrom": 1800, "count": 2 }, …]` — one item per decade, `yearFrom` is an integer year |
| `foundationRiskDistribution` | `[{ "foundationRisk": "a", "percentage": 81.01 }, …]` — categories with 0 % are omitted |
| `totalIncidentCount`, `municipalityIncidentCount`, `totalReportCount`, `municipalityReportCount` | `[{ "year": 2024, "count": 7 }, …]` |
| `dataCollectedPercentage` | number |
| `totalBuildingRestoredCount` | integer |

Enum values follow the [enum reference](#enum-reference).

## 5. Error responses

Every non-200 response has a consistent JSON body:

```json
{ "code": "building_not_found", "message": "No data available for building 'NL.IMBAG.PAND.0599100000369041'." }
```

`code` is a stable, machine-readable identifier — switch on it in your integration. `message` is human-readable and may be reworded without notice; don't parse it.

| HTTP status | `code` | Meaning | Suggested follow-up |
|-------------|--------|---------|---------------------|
| 401 | `missing_api_key` | No `Authorization: Bearer` header was sent | Send the key as `Authorization: Bearer fmsk.…` |
| 401 | `invalid_api_key` | The key is unknown, disabled, or expired | Check the key; contact us if it should be active |
| 404 | `identifier_invalid` | The `{id}` is not a recognized identifier format | Resubmit with a valid BAG pand/nummeraanduiding (or CBS neighborhood for statistics) |
| 404 | `address_not_found` | Valid address format, but the address is not known in BAG | Resubmit with a corrected address |
| 404 | `building_not_found` | Valid building id format, but no such building exists in BAG | Verify the building id; no foundation data can exist for it |
| 404 | `not_a_building` | The identifier refers to a mooring or mobile-home site (ligplaats/standplaats), not a building | None — foundation risk does not apply to these objects; a QuickScan is not useful |
| 404 | `no_data_available` | The building is known, but no foundation data is available for it | Request a QuickScan to have the building assessed |
| 404 | `neighborhood_not_found` | Statistics only: the CBS neighborhood code is not known | Verify the `BU*` code |
| 404 | `route_not_found` | Unknown endpoint path | Check the request path |
| 429 | `rate_limit_exceeded` | Your per-product usage limit was reached; see the `Retry-After` and `X-RateLimit-*` headers | Retry after the indicated time |
| 500 | `internal_server_error` | Unexpected server error | Retry later; contact support if it persists |
| 503 | `service_unavailable` | Health check only (§7): the webservice is up but cannot currently serve product requests | Treat the webservice as unavailable; retry later |

The four 404 "no result" codes are designed so automated integrations (e.g. the NWWI valuation chain) can choose the correct follow-up action from `code` alone: a corrected resubmission (`identifier_invalid`, `address_not_found`), a QuickScan request (`no_data_available`), or no action (`building_not_found`, `not_a_building`).

New codes may be added over time; treat any unlisted `code` on an error status generically based on the HTTP status.

### Rate limits

Usage limits are set per API key and product as a number of billable events per calendar day or month (UTC). When a limit applies, every response to that product carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (seconds until the window resets); an exhausted limit returns `429 rate_limit_exceeded` with `Retry-After`. Repeated requests for the same building within 24 hours do not consume additional events.

## 6. Every known building carries a risk indication

Since July 2026, the model guarantees that every building known to the model carries **at least one** risk indication. When none of the component risks (`drystandRisk`, `bioInfectionRisk`, `dewateringDepthRisk`) could be computed and no report-derived class exists — typically buildings outside groundwater-model coverage or with an undetermined foundation type — `unclassifiedRisk` contains a construction-year-based estimate:

| Construction year | `unclassifiedRisk` |
|---|---|
| before 1970 | `d` |
| 1970 or later | `b` |

Notes for interpreting responses:

- This fallback is **indicative**: it is a heuristic, not a computed or inspected result. It applies to roughly 0.4% of buildings nationally.
- The component risk fields themselves stay `null` in this case. More generally, a `null` component risk is **structural, not missing data**: each component only applies to certain foundation types (e.g. `drystandRisk` to wood foundations, `dewateringDepthRisk` to no-pile foundations). Do not infer data quality from individual `null` components.
- Report-derived `unclassifiedRisk` values always take precedence over the fallback.
- Consequently, the `no_data_available` error (§5) is rare in practice and mainly occurs for buildings not yet present in the current model snapshot, such as very recent BAG additions.
- **Do not assert on this.** The fallback is derived from the construction year, so a building whose construction year is itself unknown gets no fallback and returns `null` for all four risk fields. In the current snapshot that is exactly 1 building out of 11.2M — but it is not zero, so treat "all risks null" as a case your code handles rather than an impossible state.

## 7. Health check

`GET /v4/health` reports whether the webservice can currently serve product requests. It is **unauthenticated**, never billed, and intended for availability monitors.

```bash
curl -i https://ws.fundermaps.com/v4/health
```

| HTTP status | Body | Meaning |
|-------------|------|---------|
| 200 | `{ "status": "ok" }` | The webservice is up and can reach its data |
| 503 | `{ "code": "service_unavailable", "message": "…" }` | The webservice is up but cannot currently serve requests — retry later |
| anything else, or no response | — | The webservice itself is unreachable |

Treat the **HTTP status** as the contract: `200` means available, anything else means unavailable. The body is informational and deliberately carries no technical detail (no versions, hostnames, or timings).

- Responses carry `Cache-Control: no-store`; every call reflects the current state.
- The state is re-evaluated at most once every 5 seconds server-side. Once a minute is a sensible polling interval; polling faster does not give fresher answers.
- A `200` says the service is available, not that a specific building has data — the `404` codes in §5 still apply to product calls.
- Staging exposes the same endpoint at `https://ws-staging.fundermaps.com/v4/health`.

## Enum reference

The values below are the exact, complete label sets of the database enum types the API serves from — every value a v4 response can contain is listed, and a CI check keeps this table in sync with the implementation (`src/enums.ts`). All enum fields are nullable: expect `null` when the underlying data point is absent.

| Field | Values |
|-------|--------|
| foundationType | `wood`, `concrete`, `no_pile`, `wood_charger`, `weighted_pile`, `combined`, `steel_pile`, `other`, `no_pile_masonry`, `no_pile_strips`, `no_pile_concrete_floor`, `no_pile_slit`, `wood_amsterdam`, `wood_rotterdam`, `no_pile_bearing_floor`, `wood_rotterdam_amsterdam`, `wood_rotterdam_arch`, `wood_amsterdam_arch` |
| reliability | `indicative`, `established`, `cluster`, `supercluster` |
| foundationRisk | `a`, `b`, `c`, `d`, `e` |
| damageCause | `drainage`, `construction_flaw`, `drystand`, `overcharge`, `overcharge_negative_cling`, `negative_cling`, `bio_infection`, `fungus_infection`, `bio_fungus_infection`, `foundation_flaw`, `construction_heave`, `subsidence`, `vegetation`, `gas`, `vibrations`, `partial_foundation_recovery`, `japanese_knotweed`, `groundwater_level_reduction` |
| inquiryType | `monitoring`, `note`, `quickscan`, `unknown`, `demolition_research`, `second_opinion`, `archive_research`, `architectural_research`, `foundation_advice`, `inspectionpit`, `foundation_research`, `additional_research`, `ground_water_level_research`, `soil_investigation`, `facade_scan` |
| recoveryType | `table`, `beam_on_pile`, `pile_lowering`, `pile_in_wall`, `injection`, `unknown` |
| facadeScanRisk | `a`, `b`, `c`, `d`, `e` |
| settlementSpeed | `nil`, `small`, `mediocre`, `big`, `very_big` |
| skewedParallelFacade | `nil`, `small`, `mediocre`, `big`, `very_big` |
| skewedPerpendicularFacade | `nil`, `small`, `mediocre`, `big`, `very_big` |
| facadeCrack | `none`, `nil`, `small`, `mediocre`, `big` |
| overallQuality | `bad`, `mediocre`, `tolerable`, `good`, `mediocre_good`, `mediocre_bad` |
| enforcementTerm | `term05`, `term510`, `term1020`, `term5`, `term10`, `term15`, `term20`, `term25`, `term30`, `term40` |

> **Correction notice (June 2026).** Earlier revisions of this table were incomplete and listed four `inquiryType` values that the API never returns. If you implemented against an earlier revision, update your parsers:
>
> - `monitor` → the API returns `monitoring`
> - `inspection` → the API returns `inspectionpit`
> - `demolition` → the API returns `demolition_research`
> - `quick_scan` → the API returns `quickscan`
>
> Additionally, 8 `foundationType` values, 5 `damageCause` values, and 4 further `inquiryType` values (`archive_research`, `ground_water_level_research`, `soil_investigation`, `facade_scan`) were missing and have been added above. Treat any enum value outside this table as a defect and report it to us.

## Appendix: coming from v3

`/api/v3` was retired on 2026-08-29. The data and its meaning did not change between v3 and v4 — the same building returns the same assessment — but the wire format did. This appendix exists so historical v3 output can be reconciled with v4; nothing in it is needed for a new integration.

- **Paths:** `/api/v3/product/{analysis|statistics}/{id}` → `/v4/product/…/{id}`. `risk`, `light`, `facade_scan`, `foundation-research`, `usage`, `health` and `mcp` have no v3 equivalent.
- **Authentication:** only `Authorization: Bearer fmsk.…`; `X-API-Key`, `Authorization: authkey` and `?authkey=` are gone.
- **Enums are strings, not integers** — mapping tables below. Do not derive the mapping from the position of a value in the [enum reference](#enum-reference); that table follows the database ordering, which is not the v3 ordering.
- **Analysis:** `enforcementTerm` and `overallQuality` were removed (source column had drifted from the documented semantics); `addressCount` was added.
- **Statistics:** `foundationTypeDistribution` is the array itself (was `{ foundationTypes: [...] }`); `constructionYearDistribution` items are `{ yearFrom, count }` (was nested `decade.yearFrom/yearTo` dates + `totalCount`); `foundationRiskDistribution` is an array of `{ foundationRisk, percentage }` (was `percentageA`–`percentageE`); the four year-count arrays renamed `totalCount` → `count`.
- **Errors:** every non-200 response is `{ code, message }` with a stable `code` (§5).

### Integer → string mapping

The underlying values did **not** change — only their encoding. A building that returned `foundationType: 3` from v3 returns `foundationType: "concrete"` from v4 for the same identifier, from the same source data. Use these tables to reconcile historical v3 output with v4 output.

> ⚠️ **Do not derive this mapping from the position of a value in the [enum reference](#enum-reference) table.** That table is ordered by the database's own enum ordering, which is **not** the v3 integer ordering. Mapping by position silently yields `concrete` where v3 said `wood_amsterdam`, and so on. Use the explicit tables below.

**`Reliability`** — applies to all `*Reliability` fields:

| v3 | v4 |
|----|----|
| `0` | `indicative` |
| `1` | `established` |
| `2` | `cluster` |
| `3` | `supercluster` |

**`FoundationRisk`** — applies to `drystandRisk`, `bioInfectionRisk`, `dewateringDepthRisk`, `unclassifiedRisk`, and `facadeScanRisk`:

| v3 | v4 |
|----|----|
| `0` | `a` |
| `1` | `b` |
| `2` | `c` |
| `3` | `d` |
| `4` | `e` |

**`foundationType`:**

| v3 | v4 |
|----|----|
| `0` | `wood` |
| `1` | `wood_amsterdam` |
| `2` | `wood_rotterdam` |
| `3` | `concrete` |
| `4` | `no_pile` |
| `5` | `no_pile_masonry` |
| `6` | `no_pile_strips` |
| `7` | `no_pile_bearing_floor` |
| `8` | `no_pile_concrete_floor` |
| `9` | `no_pile_slit` |
| `10` | `wood_charger` |
| `11` | `weighted_pile` |
| `12` | `combined` |
| `13` | `steel_pile` |
| `14` | `other` |
| `15` | `wood_rotterdam_amsterdam` |
| `16` | `wood_rotterdam_arch` |
| `17` | `wood_amsterdam_arch` |

**`inquiryType`:**

| v3 | v4 |
|----|----|
| `0` | `additional_research` |
| `1` | `monitoring` |
| `2` | `note` |
| `3` | `quickscan` |
| `4` | `unknown` |
| `5` | `demolition_research` |
| `6` | `second_opinion` |
| `7` | `archive_research` |
| `8` | `architectural_research` |
| `9` | `foundation_advice` |
| `10` | `inspectionpit` |
| `11` | `foundation_research` |
| `12` | `ground_water_level_research` |
| `13` | `soil_investigation` |
| `14` | `facade_scan` |

**`recoveryType`:**

| v3 | v4 |
|----|----|
| `0` | `table` |
| `1` | `beam_on_pile` |
| `2` | `pile_lowering` |
| `3` | `pile_in_wall` |
| `4` | `injection` |
| `5` | `unknown` |

**`damageCause`** — note that **`7` is not used**; the v3 integer sequence has a gap there. Do not assume contiguous values.

| v3 | v4 |
|----|----|
| `0` | `drainage` |
| `1` | `construction_flaw` |
| `2` | `drystand` |
| `3` | `overcharge` |
| `4` | `overcharge_negative_cling` |
| `5` | `negative_cling` |
| `6` | `bio_infection` |
| `8` | `fungus_infection` |
| `9` | `bio_fungus_infection` |
| `10` | `foundation_flaw` |
| `11` | `construction_heave` |
| `12` | `subsidence` |
| `13` | `vegetation` |
| `14` | `gas` |
| `15` | `vibrations` |
| `16` | `partial_foundation_recovery` |
| `17` | `japanese_knotweed` |
| `18` | `groundwater_level_reduction` |
