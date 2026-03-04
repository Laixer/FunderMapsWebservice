# CLAUDE.md

## Project Overview

FunderMaps Webservice is a standalone, mission-critical product API serving analysis and statistics data for Dutch buildings. It replaces the C# `FunderMaps.Webservice` with a minimal Bun + Hono app.

Every request is a billable product call. Uptime and correctness are paramount.

## Common Commands

```bash
bun install          # install dependencies
bun run src/index.ts # start the server (port 8080)
```

## Architecture

3 dependencies: `hono`, `postgres`, `zod`. No ORM — raw SQL via postgres.js tagged templates.

### Request Flow

```
Request → Extract API key (4 methods) → Validate key in DB → Resolve geocoder ID → Query product data → Track usage → Respond
```

### Endpoints

- `GET /api/v3/product/analysis/:id` — building risk analysis
- `GET /api/v3/product/statistics/:id` — neighborhood statistics (9 parallel queries)
- `GET /health` — health check

### Authentication

API-key only. 4 delivery methods (checked in order):
1. `Authorization: Bearer fmsk.xxx` (preferred)
2. `X-API-Key: fmsk.xxx`
3. `Authorization: authkey fmsk.xxx` (legacy)
4. `?authkey=fmsk.xxx` (legacy)

No role checks. Key existence in `application.auth_key` = authorized.
Auth query joins `auth_key → user → organization_user` in one round-trip.

### Geocoder ID Resolution

The `:id` parameter accepts multiple identifier formats:
- BAG building: `NL.IMBAG.PAND.{16digits}`
- BAG address: `NL.IMBAG.NUMMERAANDUIDING.{16digits}` → resolves to building
- Legacy BAG: `{16digits}` with `10` at pos 4-5 (building) or `20` (address)
- GFM: `gfm-{hex}` → looks up `external_building_id` via `model_risk_static`
- CBS: `BU{10}` (neighborhood), `WK{8}` (district), `GM{6}` (municipality) → statistics only

### Product Tracking

After-response middleware inserts into `application.product_tracker` with 24-hour deduplication per (organization_id, product, identifier). Tracking failures are silently caught — never breaks the response.

### Key Database Tables/Views

- `data.model_risk_static` — main analysis view (building_id=GFM, external_building_id=BAG)
- `data.statistics_product_*` — 9 statistics views (all keyed by GFM neighborhood_id or municipality_id)
- `application.auth_key` — API keys (key + user_id)
- `application.product_tracker` — usage tracking (building_id is GFM geocoder_id type)
- `geocoder.building` — id=GFM, external_id=BAG
- `geocoder.neighborhood/district/municipality` — GFM IDs with CBS external_ids

### Important: ID Format Mismatch

- `model_risk_static.building_id` = GFM internal ID
- `model_risk_static.external_building_id` = BAG external ID
- `statistics_product_*.neighborhood_id` = GFM internal ID
- `product_tracker.building_id` = GFM internal ID (FK to geocoder.building)
- `geocoder.building_geocoder.building_id` = BAG external ID (confusingly named)

## File Structure

```
src/
├── index.ts        # Hono app, middleware stack, error handler
├── config.ts       # DATABASE_URL + PORT (8080), Zod validated
├── db.ts           # postgres.js connection with numeric/bigint type parsers
├── auth.ts         # API key middleware (4 methods, single join query)
├── geocoder.ts     # ID format detection + resolution functions
├── tracker.ts      # After-response product tracking middleware
└── routes/
    └── product.ts  # analysis + statistics endpoints
```

## Differences from C# Webservice

- Enums returned as strings (`"concrete"`) not integers (`3`)
- Statistics response uses flat arrays, not nested wrapper objects
- Construction years as integers (`1800`) not ISO timestamps
- Foundation risk as array of objects, not `percentageA/B/C/D/E` keys
- Municipality data actually works (C# had a bug with GFM→CBS resolution)
- `enforcementTerm` and `overallQuality` included in analysis response
- Supports `Authorization: Bearer` for API keys (new, preferred method)
