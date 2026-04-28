# Webservice Migration Guide

## What's changing

We're upgrading the FunderMaps webservice. You'll need to update your integration to use the new endpoints, authentication, and response format.

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

When we cut over, the same `/v4/...` paths will be served from `ws.fundermaps.com`. Until then, `ws.fundermaps.com/v4/...` returns 404 — use the staging hostname while migrating.

We'll announce the cutover date separately. After cutover, both hostnames will continue to work for a deprecation window.

## 1. Base URL & paths

```
# Old
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
| `/v4/product/analysis/{id}` | Full BAG (`NL.IMBAG.PAND.0599100000369041`) or 16-digit BAG (`0599100000369041`) |
| `/v4/product/statistics/{id}` | Full BAG, 16-digit BAG, CBS neighborhood (`BU03630000`), or GFM (`gfm-...`) |

Unrecognized or unresolvable IDs return `404 {"message":"Not found"}`.

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

## 5. Removed analysis fields

Two fields that existed in v3 are **not returned** in v4:

- `enforcementTerm`
- `overallQuality`

Both were dropped because the underlying source column had drifted away from the documented enum semantics. If your integration depended on them, contact us before migrating.

## Quick checklist

- [ ] Validate against `https://ws-staging.fundermaps.com/v4/...` before changing your production base URL
- [ ] Update authentication: use `Authorization: Bearer fmsk.your_api_key`
- [ ] Update base URL: drop `/api`, change `v3` to `v4`
- [ ] Update enum parsing: integers → strings
- [ ] Update `foundationTypeDistribution` parsing: read array directly
- [ ] Update `constructionYearDistribution` parsing: `yearFrom` is an integer, `yearTo` removed, `totalCount` → `count`
- [ ] Update `foundationRiskDistribution` parsing: read array of objects instead of `percentageA`–`percentageE` keys
- [ ] Remove any reads of `enforcementTerm` / `overallQuality` from the analysis response

## Enum reference

| Field | Values |
|-------|--------|
| foundationType | `wood`, `wood_amsterdam`, `wood_rotterdam`, `concrete`, `no_pile`, `wood_charger`, `weighted_pile`, `combined`, `steel_pile`, `other` |
| reliability | `indicative`, `established` |
| foundationRisk | `a`, `b`, `c`, `d`, `e` |
| damageCause | `bio_infection`, `drainage`, `construction_flaw`, `drystand`, `overcharge_negative_cling`, `negative_cling`, `overcharge`, `vegetation`, `gas`, `vibrations`, `foundation_flaw`, `partial_foundation_recovery`, `subsidence` |
| inquiryType | `additional_research`, `architectural_research`, `demolition`, `foundation_advice`, `foundation_research`, `inspection`, `monitor`, `note`, `second_opinion`, `quick_scan`, `unknown` |
| recoveryType | `beam_on_pile`, `pile_in_wall`, `table`, `injection`, `unknown` |
