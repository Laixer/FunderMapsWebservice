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
Request → Extract API key (2 methods) → Validate key in DB (60s cache) → Resolve geocoder ID → Query product data → Track usage → Respond
```

### Endpoints

- `GET /v4/product/analysis/:id` — building risk analysis
- `GET /v4/product/statistics/:id` — neighborhood statistics (9 parallel queries)
- `GET /v4/usage` — per-tenant request count stats (daily/monthly/total)
- `GET /health` — health check

### Authentication

API-key only. Single delivery method: `Authorization: Bearer fmsk.xxx`.

Legacy `Authorization: authkey` and `?authkey=` methods were removed in commit `9485134`. `X-API-Key` header support was removed afterwards (see MIGRATION.md).

No role checks. Key existence in `application.auth_key` = authorized.
Auth query joins `auth_key → user → organization_user` in one round-trip, with a 60s in-memory cache per key (`AUTH_TTL_MS`).

### Geocoder ID Resolution

The `:id` parameter currently supports:
- BAG building: `NL.IMBAG.PAND.{16digits}`
- Legacy BAG building: `{16digits}` with `10` at pos 4-5
- CBS neighborhood: `BU{8digits}` (10 chars total) — statistics only

Not yet implemented (planned per C# v3 parity): BAG address (`NL.IMBAG.NUMMERAANDUIDING.*`), legacy BAG address (`20` at pos 4-5), CBS district (`WK*`), CBS municipality (`GM*`).

GFM identifiers (`gfm-*`) are intentionally out of scope for v4. The `detectFormat` branch exists but the lookup path does not resolve correctly, and that is accepted — `gfm-*` inputs return 404.

### Product Tracking

After-response middleware inserts into `application.product_tracker` with 24-hour deduplication per (organization_id, product, building_id). Dedup is keyed on the resolved BAG id so that case/whitespace variants of the same identifier can't produce multiple billable rows in a 24h window. The `identifier` column preserves the raw client-supplied id for observability. Tracking failures are silently caught — never break the response.

### Key Database Tables/Views

- `data.model_risk_static` — main analysis view. Keyed by `building_id` (BAG, e.g. `NL.IMBAG.PAND.*`). `neighborhood_id` column holds the GFM neighborhood id.
- `data.statistics_product_*` — 9 statistics views (all keyed by GFM neighborhood_id or municipality_id)
- `application.auth_key` — API keys (key + user_id)
- `application.product_tracker` — usage tracking. `building_id` stores the resolved BAG id (typed `geocoder.geocoder_id`, FK to `geocoder.building.external_id`); `identifier` preserves the raw client-supplied id.
- `geocoder.building` — id=GFM, external_id=BAG
- `geocoder.neighborhood/district/municipality` — GFM IDs with CBS external_ids

### Important: ID Formats Across Schemas

- `model_risk_static.building_id` = **BAG** external id (despite the unprefixed name). No `external_building_id` column exists.
- `model_risk_static.neighborhood_id` = GFM internal id.
- `statistics_product_*.neighborhood_id` = GFM internal id.
- `product_tracker.building_id` = BAG external id (FK to `geocoder.building.external_id`).
- `geocoder.building.id` = GFM internal id; `geocoder.building.external_id` = BAG.
- `geocoder.neighborhood.id` = GFM internal id; `geocoder.neighborhood.external_id` = CBS `BU*` code.

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
    ├── product.ts  # analysis + statistics endpoints
    └── usage.ts    # /v4/usage endpoint
```

## Differences from C# Webservice

- Enums returned as strings (`"concrete"`) not integers (`3`)
- Statistics response uses flat arrays, not nested wrapper objects
- Construction years as integers (`1800`) not ISO timestamps
- Foundation risk as array of objects, not `percentageA/B/C/D/E` keys
- Municipality data actually works (C# had a bug with GFM→CBS resolution)
- `enforcementTerm` and `overallQuality` included in analysis response
- Supports `Authorization: Bearer` for API keys (new, preferred method)
