# CLAUDE.md

## Project Overview

FunderMaps Webservice is a standalone, mission-critical product API serving analysis and statistics data for Dutch buildings. It replaces the C# `FunderMaps.Webservice` with a minimal Bun + Hono app.

Every request is a billable product call. Uptime and correctness are paramount.

## Common Commands

```bash
bun install          # install dependencies
bun run src/index.ts # start the server (port 8080)
bun test             # run unit tests (src/*.test.ts)
bun run typecheck    # tsc --noEmit
```

## Architecture

3 dependencies: `hono`, `postgres`, `zod`. No ORM — raw SQL via postgres.js tagged templates.

### Request Flow

```
Request → Extract API key (2 methods) → Validate key in DB (60s cache) → Resolve geocoder ID → Query product data → Track usage → Respond
```

### Endpoints

- `GET /v4/product/analysis/:id` — building risk analysis
- `GET /v4/product/risk/:id` — subset of `analysis` for valuation chains and dashboards (issue #985)
- `GET /v4/product/light/:id` — minimal output with a derived `overallRisk`; see `src/risk.ts` for the priority rules and the recovery-type override (issue #985)
- `GET /v4/product/statistics/:id` — neighborhood statistics (9 parallel queries)
- `GET /v4/usage` — per-tenant request count stats (daily/monthly/total)
- `GET /health` — health check

Each `/v4/product/*` route is wrapped in a `rateLimit(<trackerName>)` middleware that enforces a per-(API key, product) calendar-window limit against `application.api_key_rate_limit`. The unit is **billable events** (post-dedup `product_tracker` rows), not raw requests — same unit we bill on. Absent config row = unlimited. Overage returns 429 + `Retry-After` and emits a one-line JSON `rate_limit_exceeded` log for monitoring. See `src/rate-limit.ts` and issue #8.

### Authentication

API-key only. Single delivery method: `Authorization: Bearer fmsk.xxx`. Legacy `Authorization: authkey` and `?authkey=` were removed in `9485134`; `X-API-Key` in `257d98e` (see MIGRATION.md).

No role checks. Key existence in either api-key table = authorized.

Auth is **dual-stack** as of `72a11e3` (Phase B.2 of the apiKey migration):
- `application.auth_key` — legacy keys hashed as SHA-256 hex.
- `application.apikey` — Better Auth `@better-auth/api-key` plugin keys hashed as SHA-256 base64url (no padding). New keys created via the TS API's management routes land here.

`resolveKey` issues a single `UNION ALL` joining `organization_user` on both branches and returns at most one row (a plaintext only matches one table). The `source` column ("legacy" vs "ba") routes the fire-and-forget usage UPDATE to the right table. 60s in-memory cache per key (`AUTH_TTL_MS`); cache miss is the only time we hit the DB or bump usage. We deliberately don't pull in `better-auth` as a dependency on this billable surface — the BA hash format is reproduced inline (`sha256Base64Url`).

The legacy branch dies in Phase D once the C# Webservice retires (end of Dec 2026) and `auth_key` drains.

### Geocoder ID Resolution

The `:id` parameter currently supports:
- BAG building: `NL.IMBAG.PAND.{16digits}`
- Legacy BAG building: `{16digits}` with `10` at pos 4-5
- BAG address: `NL.IMBAG.NUMMERAANDUIDING.{16digits}` — resolves via `geocoder.address.external_id → building_id` (N:1, two nummeraanduidingen on the same pand return the same building)
- Legacy BAG address: `{15-16 digits}` with `20` at pos 4-5 (15-digit form is zero-padded to 16 before lookup)
- CBS neighborhood: `BU{8digits}` (10 chars total) — statistics only

CBS district (`WK*`) and CBS municipality (`GM*`) are deliberately not in `detectFormat` — the `/v4/product/statistics` endpoint is keyed by neighborhood, so adding these formats without an endpoint that consumes them would mean format-recognized inputs returning 404 from the lookup query (worse UX than the unknown-format 404 they get today). Reopen if a district/municipality-level product endpoint ships.

GFM identifiers (`gfm-*`) are intentionally out of scope for v4 and return 404. The `gfm` branch in `detectFormat` is preserved so future GFM-aware paths can pattern-match against it; the corresponding lookup branches return null/404 by design.

### Product Tracking

After-response middleware inserts into `application.product_tracker` with 24-hour deduplication per (organization_id, product, building_id). Dedup is keyed on the resolved BAG id so that case/whitespace variants of the same identifier can't produce multiple billable rows in a 24h window. The `identifier` column preserves the raw client-supplied id for observability. Tracking failures are silently caught — never break the response.

### Key Database Tables/Views

- `data.model_risk_static` — main analysis view. Keyed by `building_id` (BAG, e.g. `NL.IMBAG.PAND.*`). `neighborhood_id` column holds the GFM neighborhood id.
- `data.statistics_product_*` — 9 statistics views (all keyed by GFM neighborhood_id or municipality_id)
- `application.auth_key` — legacy API keys (SHA-256 hex hash of plaintext; `key_hash` + `user_id`; `last_used` bumped fire-and-forget on cache miss)
- `application.apikey` — Better Auth plugin API keys (SHA-256 base64url-no-padding hash; `key` + `reference_id` (=user_id); `last_request` + `request_count` bumped on cache miss)
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
├── auth.ts         # API key middleware (Bearer only; dual-stack UNION ALL across auth_key + apikey)
├── geocoder.ts     # ID format detection + resolution functions
├── rate-limit.ts   # Per-(key, product) calendar-window rate limit middleware
├── risk.ts         # Pure overallRisk computation for /v4/product/light
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
- `enforcementTerm` and `overallQuality` dropped from the analysis response
- Supports `Authorization: Bearer` for API keys (new, preferred method)
