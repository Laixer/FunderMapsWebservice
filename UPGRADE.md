# Webservice API v4 Upgrade Guide

This document describes the changes when migrating from the v3 C# webservice to the v4 webservice.

## Base URL

The base URL will change. Update your configuration:

```
# Old
https://ws.fundermaps.com

# New
TBD — will be communicated before migration
```

## Authentication

### New: Bearer token support (recommended)

The preferred authentication method is now a standard Bearer token:

```
Authorization: Bearer fmsk.your_api_key
```

### Existing methods still supported

All existing authentication methods continue to work:

```
X-API-Key: fmsk.your_api_key
Authorization: authkey fmsk.your_api_key
?authkey=fmsk.your_api_key
```

### Role requirement removed

API keys no longer require the `service` role. If your key works today, it will continue to work.

## Endpoints

The endpoint paths have changed — the `/api` prefix is dropped and version bumped to v4:

```
# Old
GET /api/v3/product/analysis/{id}
GET /api/v3/product/statistics/{id}

# New
GET /v4/product/analysis/{id}
GET /v4/product/statistics/{id}
```

All existing identifier formats continue to work (BAG, legacy BAG, GFM, CBS).

## Response Changes

### Analysis endpoint

#### Enums are now strings instead of integers

```jsonc
// Old
{ "foundationType": 3, "constructionYearReliability": 0, "drystandRisk": 0 }

// New
{ "foundationType": "concrete", "constructionYearReliability": "indicative", "drystandRisk": "a" }
```

Enum value mappings for reference:

**foundationType**: `wood`, `wood_amsterdam`, `wood_rotterdam`, `concrete`, `no_pile`, `wood_charger`, `weighted_pile`, `combined`, `steel_pile`, `other`

**reliability**: `indicative`, `established`

**foundationRisk**: `a`, `b`, `c`, `d`, `e`

**damageCause**: `bio_infection`, `drainage`, `construction_flaw`, `drystand`, `overcharge_negative_cling`, `negative_cling`, `overcharge`, `vegetation`, `gas`, `vibrations`, `foundation_flaw`, `partial_foundation_recovery`, `subsidence`

**inquiryType**: `additional_research`, `architectural_research`, `demolition`, `foundation_advice`, `foundation_research`, `inspection`, `monitor`, `note`, `second_opinion`, `quick_scan`, `unknown`

**overallQuality**: `bad`, `mediocre_bad`, `mediocre`, `mediocre_good`, `good`

**recoveryType**: `beam_on_pile`, `pile_in_wall`, `table`, `injection`, `unknown`

#### New fields added

Two fields are now included that were previously omitted:

```jsonc
{
  // ... existing fields ...
  "enforcementTerm": 5,        // integer or null — years until enforcement action
  "overallQuality": "mediocre" // string or null — overall foundation quality rating
}
```

### Statistics endpoint

#### Structure changes

The response structure has been simplified. Nested wrapper objects are replaced with flat arrays.

**Foundation type distribution:**

```jsonc
// Old
{
  "foundationTypeDistribution": {
    "foundationTypes": [
      { "foundationType": 3, "percentage": 81.01 }
    ]
  }
}

// New
{
  "foundationTypeDistribution": [
    { "foundationType": "concrete", "percentage": 81.01 }
  ]
}
```

**Construction year distribution:**

```jsonc
// Old
{
  "constructionYearDistribution": {
    "decades": [
      {
        "decade": {
          "yearFrom": "1800-01-01T00:00:00+00:00",
          "yearTo": "1809-01-01T00:00:00+00:00"
        },
        "totalCount": 2
      }
    ]
  }
}

// New
{
  "constructionYearDistribution": [
    { "yearFrom": 1800, "count": 2 }
  ]
}
```

**Foundation risk distribution:**

```jsonc
// Old
{
  "foundationRiskDistribution": {
    "percentageA": 81.01,
    "percentageB": 0.76,
    "percentageC": 16.71,
    "percentageD": 1.52,
    "percentageE": 0
  }
}

// New
{
  "foundationRiskDistribution": [
    { "foundationRisk": "a", "percentage": 81.01 },
    { "foundationRisk": "b", "percentage": 0.76 },
    { "foundationRisk": "c", "percentage": 16.71 },
    { "foundationRisk": "d", "percentage": 1.52 }
  ]
}
```

Note: risk categories with 0% are no longer included in the array.

#### Municipality data fix

Municipality-level incident and report counts now work correctly. The previous webservice had a bug that returned empty arrays for these fields in most cases. You may now see data where there was none before:

```jsonc
{
  "municipalityIncidentCount": [
    { "year": 2023, "count": 2 }
  ],
  "municipalityReportCount": [
    { "year": 2025, "count": 57 }
  ]
}
```

## Summary of breaking changes

| Change | Impact | Action required |
|--------|--------|----------------|
| Enums as strings | All enum fields | Update parsers to handle strings instead of integers |
| Statistics structure flattened | `foundationTypeDistribution`, `constructionYearDistribution`, `foundationRiskDistribution` | Update JSON parsing to read arrays directly |
| Construction years as integers | `constructionYearDistribution` | Parse `yearFrom` as integer, `yearTo` removed |
| Risk distribution as array | `foundationRiskDistribution` | Iterate array instead of reading `percentageA-E` keys |
| New analysis fields | `enforcementTerm`, `overallQuality` | No action needed (additive) |
| Endpoint paths changed | `/api/v3/product/*` → `/v4/product/*` | Update base URL and paths |
| Municipality data populated | `municipalityIncidentCount`, `municipalityReportCount` | No action needed (bug fix) |
