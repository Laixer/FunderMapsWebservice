# Webservice Migration Guide

## What's changing

We're upgrading the FunderMaps webservice. You'll need to update your integration to use the new endpoints, authentication, and response format.

**v4 is not a drop-in replacement for v3.** The underlying data and its meaning are unchanged — the same building returns the same assessment — but the wire format changed in ways that will break an unmodified v3 client: enums are strings instead of integers (§3), three statistics structures were flattened (§4), and two analysis fields were removed while one was added (§5). Every difference we know of is documented in this guide; work through the [quick checklist](#quick-checklist) before cutting over. If you find a difference that is *not* listed here, treat it as a defect and report it to us.

## Test against staging before cutover

The new webservice is live on a staging hostname so you can validate your integration before the production cutover:

```
https://ws-staging.fundermaps.com/v4/product/analysis/{id}
https://ws-staging.fundermaps.com/v4/product/statistics/{id}
```

Your existing API key works on staging — same key, same Bearer header. The staging service reads the same production database, so responses are real.

```bash
curl -H "Authorization: Bearer fmsk.your_api_key" \
  "https://ws-staging.fundermaps.com/v4/product/analysis/NL.IMBAG.PAND.1734101000021359"
```

`ws.fundermaps.com/v4/...` is the production endpoint. Staging is for trying things out; production traffic should go to `ws.fundermaps.com`.

**The old `/api/v3` endpoints were switched off on 2026-08-29** (end-of-life was announced for end of August 2026). Requests to `ws.fundermaps.com/api/v3/...` now return `404`; there is no deprecation window left.

## 1. Base URL & paths

```
# Old (switched off 2026-08-29)
GET https://ws.fundermaps.com/api/v3/product/analysis/{id}
GET https://ws.fundermaps.com/api/v3/product/statistics/{id}

# New
GET https://ws.fundermaps.com/v4/product/analysis/{id}
GET https://ws.fundermaps.com/v4/product/statistics/{id}
```

The `/api` prefix is removed and the version changes from `v3` to `v4`.

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

Unrecognized or unresolvable IDs return a `404` with a structured error body — see [Error responses](#6-error-responses).

### New in v4: `/v4/product/risk` and `/v4/product/light`

Two additional product endpoints are available in v4 with no v3 equivalent.

**`/v4/product/risk/{id}`** — a subset of `analysis` for valuation chains and dashboards. Returns: `buildingId`, `foundationType`, `foundationTypeReliability`, `restorationCosts`, `inquiryType`, `drystandRisk`, `drystandReliability`, `bioInfectionRisk`, `bioInfectionReliability`, `dewateringDepthRisk`, `dewateringDepthReliability`, `unclassifiedRisk`, `recoveryType`.

Field names and semantics are identical to the corresponding fields in `analysis` — note that the reliability fields are `drystandReliability`, `bioInfectionReliability` and `dewateringDepthReliability` (not `…RiskReliability`).

**`/v4/product/light/{id}`** — minimal response for fast integrations. Collapses the three component risks into a single derived `overallRisk` + `overallRiskReliability`. If a `recoveryType` is set on the building (i.e. the foundation has been restored), `overallRisk` is forced to `a` with `established` reliability. Returns: `restorationCosts`, `drystandRisk`, `overallRisk`, `overallRiskReliability`.

### New in v4: research outcome endpoints

Where `analysis` returns the **model-based** risk assessment, these two endpoints return the summarized outcome of **actually performed research** on the building, where available. They complement `analysis`; they do not replace it.

**`/v4/product/facade_scan/{id}`** — the most recent facade scan (QuickScan) for the building, provided its report is **less than 3 years old**. Returns: `buildingId`, `inquiryId`, `inquiryType` (`facade_scan`), `documentDate` (`YYYY-MM-DD`), `validUntil` (`documentDate` + 3 years), `facadeScanRisk` (`a`–`e`), `settlementSpeed`, `skewedParallelFacade`, `skewedPerpendicularFacade`, `facadeCrack`, `contractor`.

**`/v4/product/foundation-research/{id}`** — the most recent foundation research for the building, provided its report is **less than 5 years old**. Returns: `buildingId`, `inquiryId`, `inquiryType` (`foundation_research`), `documentDate`, `validUntil` (`documentDate` + 5 years), `settlementSpeed`, `skewedParallelFacade`, `skewedPerpendicularFacade`, `facadeCrack`, `overallQuality`, `recoveryAdvised` (boolean), `enforcementTerm`, `contractor`.

Notes for both:

- All fields are nullable except `buildingId`. A `null` means the underlying report did not record that observation.
- Building-level: a nummeraanduiding resolves to its pand first, so two addresses on the same building return the same outcome — the research is attached to the building, not to one address.
- "Latest available" = the newest report by `documentDate` of that research type within the freshness window. A building whose only research is older than the window returns `404 no_data_available`, same as a building never researched.
- The skew/settlement classifications use the same scale (`nil` → `very_big`) and derivation as the public facade-scan map layer; `facadeCrack` is the worst of the four facade crack observations.

Same authentication, ID formats, and error responses as `analysis`.

### New in v4: MCP endpoint for AI agents

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

The only supported authentication method is now a standard Bearer token:

```
Authorization: Bearer fmsk.your_api_key
```

The previous methods (`X-API-Key` header, `Authorization: authkey` header, `?authkey=` query parameter) are no longer supported.

Your existing API key remains valid — only the way you send it changes.

## 3. Analysis response: enums are now strings

All enum fields return human-readable strings instead of integer codes.

```json
// Before
{ "foundationType": 3, "drystandRisk": 0 }

// After
{ "foundationType": "concrete", "drystandRisk": "a" }
```

**Action:** Update your parsers to handle string values for all enum fields. The possible values are listed in the reference table at the end of this document.

This affects every enum field in the analysis response: `foundationType`, `damageCause`, `inquiryType`, `recoveryType`, the five `*Reliability` fields (`constructionYearReliability`, `foundationTypeReliability`, `drystandReliability`, `bioInfectionReliability`, `dewateringDepthReliability`), and the four risk fields (`drystandRisk`, `bioInfectionRisk`, `dewateringDepthRisk`, `unclassifiedRisk`).

### v3 integer → v4 string mapping

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

## 4. Statistics response: flattened arrays

Three statistics fields have been simplified from nested objects to flat arrays.

### Foundation type distribution

```json
// Before
{ "foundationTypeDistribution": { "foundationTypes": [{ "foundationType": 3, "percentage": 81.01 }] } }

// After
{ "foundationTypeDistribution": [{ "foundationType": "concrete", "percentage": 81.01 }] }
```

### Construction year distribution

```json
// Before
{ "constructionYearDistribution": { "decades": [{ "decade": { "yearFrom": "1800-01-01T00:00:00+00:00", "yearTo": "1809-01-01T00:00:00+00:00" }, "totalCount": 2 }] } }

// After
{ "constructionYearDistribution": [{ "yearFrom": 1800, "count": 2 }] }
```

Note: `yearFrom` is now an integer, `yearTo` is removed, and `totalCount` is renamed to `count`.

### Foundation risk distribution

```json
// Before
{ "foundationRiskDistribution": { "percentageA": 81.01, "percentageB": 0.76, "percentageC": 16.71, "percentageD": 1.52, "percentageE": 0 } }

// After
{ "foundationRiskDistribution": [{ "foundationRisk": "a", "percentage": 81.01 }, { "foundationRisk": "b", "percentage": 0.76 }] }
```

Note: categories with 0% are omitted from the array.

### Year-count arrays: `totalCount` → `count`

The four year-keyed count arrays keep their field names and their nesting, but the item key `totalCount` is renamed to `count`:

```json
// Before
{ "totalIncidentCount": [{ "year": 2024, "totalCount": 7 }] }

// After
{ "totalIncidentCount": [{ "year": 2024, "count": 7 }] }
```

This applies to all four: `totalIncidentCount`, `municipalityIncidentCount`, `totalReportCount`, `municipalityReportCount`.

The remaining statistics fields — `dataCollectedPercentage` and `totalBuildingRestoredCount` — are unchanged scalars.

## 5. Analysis response: fields removed and added

Two fields that existed in v3 are **not returned** in v4:

- `enforcementTerm`
- `overallQuality`

Both were dropped because the underlying source column had drifted away from the documented enum semantics. If your integration depended on them, contact us before migrating.

One field is **new** in v4:

- `addressCount` (integer) — the number of addresses (nummeraanduidingen) on this BAG pand. Consumers use it to apportion `restorationCosts` across the individual objects within a single building. Additive: parsers that ignore unknown fields are unaffected.

## 6. Error responses

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

The four 404 "no result" codes are designed so automated integrations (e.g. the NWWI valuation chain) can choose the correct follow-up action from `code` alone: a corrected resubmission (`identifier_invalid`, `address_not_found`), a QuickScan request (`no_data_available`), or no action (`building_not_found`, `not_a_building`).

New codes may be added over time; treat any unlisted `code` on an error status generically based on the HTTP status.

## 7. Every known building carries a risk indication

Since July 2026, the model guarantees that every building known to the model carries **at least one** risk indication. When none of the component risks (`drystandRisk`, `bioInfectionRisk`, `dewateringDepthRisk`) could be computed and no report-derived class exists — typically buildings outside groundwater-model coverage or with an undetermined foundation type — `unclassifiedRisk` contains a construction-year-based estimate:

| Construction year | `unclassifiedRisk` |
|---|---|
| before 1970 | `d` |
| 1970 or later | `b` |

Notes for interpreting responses:

- This fallback is **indicative**: it is a heuristic, not a computed or inspected result. It applies to roughly 0.4% of buildings nationally.
- The component risk fields themselves stay `null` in this case. More generally, a `null` component risk is **structural, not missing data**: each component only applies to certain foundation types (e.g. `drystandRisk` to wood foundations, `dewateringDepthRisk` to no-pile foundations). Do not infer data quality from individual `null` components.
- Report-derived `unclassifiedRisk` values always take precedence over the fallback.
- Consequently, the `no_data_available` error (§6) is rare in practice and mainly occurs for buildings not yet present in the current model snapshot, such as very recent BAG additions.
- **Do not assert on this.** The fallback is derived from the construction year, so a building whose construction year is itself unknown gets no fallback and returns `null` for all four risk fields. In the current snapshot that is exactly 1 building out of 11.2M — but it is not zero, so treat "all risks null" as a case your code handles rather than an impossible state.

## Quick checklist

- [ ] Validate against `https://ws-staging.fundermaps.com/v4/...` before changing your production base URL
- [ ] Update authentication: use `Authorization: Bearer fmsk.your_api_key`
- [ ] Update base URL: drop `/api`, change `v3` to `v4`
- [ ] Update enum parsing: integers → strings — use the [explicit mapping tables](#v3-integer--v4-string-mapping), **not** the position of a value in the enum reference table
- [ ] Update `foundationTypeDistribution` parsing: read array directly
- [ ] Update `constructionYearDistribution` parsing: `yearFrom` is an integer, `yearTo` removed, `totalCount` → `count`
- [ ] Update `foundationRiskDistribution` parsing: read array of objects instead of `percentageA`–`percentageE` keys
- [ ] Update `totalIncidentCount` / `municipalityIncidentCount` / `totalReportCount` / `municipalityReportCount` parsing: item key `totalCount` → `count`
- [ ] Remove any reads of `enforcementTerm` / `overallQuality` from the analysis response
- [ ] Check your response model against the [analysis response reference](#analysis-response-reference) — `addressCount` is new in v4
- [ ] Confirm your code tolerates `null` in every risk field simultaneously (§7)

## Analysis response reference

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
| `unclassifiedRisk` | `foundationRisk` | 99% | See §7 |
| `recoveryType` | `recoveryType` | >99% | Set when the foundation has been restored |
| `addressCount` | integer | never | New in v4; addresses on this pand |

Note the asymmetry in the reliability field names: `constructionYearReliability` and `foundationTypeReliability` are named after their value field, while `drystandReliability`, `bioInfectionReliability` and `dewateringDepthReliability` are **not** `…RiskReliability`. This matches v3 exactly; it is a quirk we preserved deliberately rather than a v4 change.

The `*Reliability` fields have never been `null` in any model snapshot to date, but treat them as nullable anyway — v3's non-nullable integer encoding could not express "unknown", and v4's can.

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
