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

5 dependencies: `hono`, `postgres`, `zod`, plus `@hono/mcp` + `@modelcontextprotocol/sdk` for the MCP endpoint. No ORM — raw SQL via postgres.js tagged templates. Object storage goes through Bun's built-in `S3Client` (presign only, no SDK).

### Request Flow

```
Request → Extract API key (2 methods) → Validate key in DB (60s cache) → Resolve geocoder ID → Query product data → Track usage → Respond
```

### Endpoints

- `GET /v4/product/analysis/:id` — building risk analysis
- `GET /v4/product/risk/:id` — subset of `analysis` for valuation chains and dashboards (issue #985)
- `GET /v4/product/light/:id` — minimal output with a derived `overallRisk`; see `src/risk.ts` for the priority rules and the recovery-type override (issue #985)
- `GET /v4/product/facade_scan/:id` / `GET /v4/product/foundation-research/:id` — latest research outcome within 3 y / 5 y (issue Laixer/FunderMaps#1003), plus an optional `resource` (signed 1 h link to the source PDF; issue Laixer/FunderMapsApi#140 — see "Source document link")
- `GET /v4/product/statistics/:id` — neighborhood statistics (9 parallel queries)
- `GET /v4/usage` — per-tenant request count stats (daily/monthly/total)
- `POST /v4/mcp` — MCP server (Streamable HTTP, stateless, JSON responses) exposing every product route as a tool plus a free `find_building` address lookup; see `src/mcp.ts`
- `GET /v4/health` — public readiness check (issue Laixer/FunderMaps#1014): `SELECT 1` through the pool, 2 s timeout, verdict cached 5 s; 200 `{ status: "ok" }` or 503 `service_unavailable`; unauthenticated, never tracked. See `src/health.ts`
- `GET /health` — liveness for DigitalOcean's probes only (container-direct; the `/v4` ingress rule never exposes it). Dependency-free on purpose: must not fail on a DB blip

### MCP endpoint

`POST /v4/mcp` (`src/mcp.ts`) builds one `McpServer` + `StreamableHTTPTransport` per request (stateless: no session id, `enableJsonResponse`, non-POST → 405). `authMiddleware` runs on the route so an unauthenticated caller gets the normal JSON 401. Each product tool **dispatches in-process** via `app.request("/v4/product/…/:id", { Authorization })` with the caller's own bearer — no duplicated SQL, and auth (60s cache hit), `rateLimit`, the product query and `trackerMiddleware` all run exactly as for a REST call, so billing is identical. Tool results: 200 → body as text + `structuredContent`; non-200 → `isError` with the route's `{ code, message }` (plus `Retry-After` on 429). `find_building` (postal code + house number → `geocoder.address` rows, indexed on `postal_code`) is the only SQL the file owns and is deliberately untracked. Tool catalogue and paths are pinned by `mcp.test.ts`; adding a product route means adding a row to `PRODUCT_TOOLS`.

Each `/v4/product/*` route is wrapped in a `rateLimit(<trackerName>)` middleware that enforces a per-(API key, product) calendar-window limit against `application.api_key_rate_limit`. The unit is **billable events** (post-dedup `product_tracker` rows), not raw requests — same unit we bill on. Absent config row = unlimited. Overage returns 429 + `Retry-After` and emits a one-line JSON `rate_limit_exceeded` log for monitoring. See `src/rate-limit.ts` and issue #8.

### Source document link (`resource`)

The two research endpoints attach `resource: { url, expiresAt, mediaType }` — a presigned GET on `inquiry-report/<report.inquiry.document_file>` in the private bucket, valid for `DOCUMENT_LINK_TTL_SECONDS` (1 h). `src/document.ts` owns it. Rules, decided in Laixer/FunderMapsApi#140 (Yorick, 2026-09-04, "option A"):

- **Freshness = the data window.** Record served ⇒ link included. No separate document-age rule (the issue's "max 2 years" clause was overruled); never add a date filter here.
- **Omit, never null.** No document on file ⇒ the `resource` key is absent. "No document" = `document_file` NULL/empty or not a `<uuid>.<ext>` storage name — prod carries the literal placeholder `file` on ~110 legacy foundation-research rows whose upload never happened.
- Signing is local (Bun `S3Client.presign`, SigV4) — no object-storage round trip on the billable path, and existence is not verified per request.
- Config: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` — identical names/values to FunderMapsApi. **All optional on purpose:** unset ⇒ the service boots and serves everything as before, `resource` is omitted and one `source_document_storage_not_configured` JSON line is logged per process. So a deploy without the env can never 500 a product call — but it silently under-delivers the NWWI contract; set the env before shipping.

### Authentication

API-key only. Single delivery method: `Authorization: Bearer fmsk.xxx`. Legacy `Authorization: authkey` and `?authkey=` were removed in `9485134`; `X-API-Key` in `257d98e` (see MIGRATION.md).

No role checks. Key existence in either api-key table = authorized.

Auth is **dual-stack** as of `72a11e3` (Phase B.2 of the apiKey migration):
- `application.auth_key` — legacy keys hashed as SHA-256 hex.
- `application.apikey` — Better Auth `@better-auth/api-key` plugin keys hashed as SHA-256 base64url (no padding). New keys created via the TS API's management routes land here.

`resolveKey` issues a single `UNION ALL` joining `organization_user` on both branches and returns at most one row (a plaintext only matches one table). The `source` column ("legacy" vs "ba") routes the fire-and-forget usage UPDATE to the right table. 60s in-memory cache per key (`AUTH_TTL_MS`); cache miss is the only time we hit the DB or bump usage. We deliberately don't pull in `better-auth` as a dependency on this billable surface — the BA hash format is reproduced inline (`sha256Base64Url`).

The legacy branch dies in Phase D once `auth_key` drains (the C# Webservice was retired 2026-08-29; only customer key migration remains).

### Geocoder ID Resolution

The `:id` parameter currently supports:
- BAG building: `NL.IMBAG.PAND.{16digits}`
- Legacy BAG building: `{16digits}` with `10` at pos 4-5
- BAG address: `NL.IMBAG.NUMMERAANDUIDING.{16digits}` — resolves via `geocoder.address.external_id → building_id` (N:1, two nummeraanduidingen on the same pand return the same building)
- Legacy BAG address: `{15-16 digits}` with `20` at pos 4-5 (15-digit form is zero-padded to 16 before lookup)
- CBS neighborhood: `BU{8digits}` (10 chars total) — statistics only

CBS district (`WK*`) and CBS municipality (`GM*`) are deliberately not in `detectFormat` — the `/v4/product/statistics` endpoint is keyed by neighborhood, so adding these formats without an endpoint that consumes them would mean format-recognized inputs returning 404 from the lookup query (worse UX than the unknown-format 404 they get today). Reopen if a district/municipality-level product endpoint ships.

GFM identifiers (`gfm-*`) are intentionally out of scope for v4 and return 404. The `gfm` branch in `detectFormat` is preserved so future GFM-aware paths can pattern-match against it; the corresponding lookup branches return null/404 by design.

### Error Contract

Every non-200 response is `{ code, message }` via `errorJson()` in `src/errors.ts`. `code` is a stable machine-readable string (the `ERROR_CODES` array is the canonical list; `errors.test.ts` enforces MIGRATION.md sync); `message` is human-readable and free to change. Codes: `missing_api_key`/`invalid_api_key` (401), `identifier_invalid`/`address_not_found`/`building_not_found`/`not_a_building`/`no_data_available`/`neighborhood_not_found`/`route_not_found` (404), `rate_limit_exceeded` (429), `internal_server_error` (500). Client-supplied ids echoed in messages go through `clampId()` (64-char cap).

The 404 split exists for issue Laixer/FunderMaps#1002 (NWWI): consumers pick the follow-up from `code` alone — resubmit corrected id (`identifier_invalid`, `address_not_found`), request a QuickScan (`no_data_available`), or nothing (`building_not_found`, `not_a_building` = ligplaats/standplaats). Resolution failures come from `resolveBuilding()`'s discriminated result; pand ids still resolve as identity with **no existence check** (happy path = one query), so when the product query misses, `classifyMissingBuildingData()` does one `geocoder.building` point-lookup to split "unknown building" / "houseboat or mobile home" / "known but no data". `geocoder.address.building_id` stores the BAG external id and can point at `NL.IMBAG.LIGPLAATS.*`/`STANDPLAATS.*` — that prefix is how `not_a_building` is detected at resolve time. Still open from #1002: 200-with-null-risk responses carry no explicit reason, and 404 misses are not tracked server-side (deliberately skipped).

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
├── config.ts       # DATABASE_URL + PORT (8080) + optional S3_* (source documents), Zod validated
├── db.ts           # postgres.js connection with numeric/bigint type parsers
├── errors.ts       # Non-200 { code, message } contract: ErrorCode union + errorJson/clampId helpers
├── document.ts     # `resource` on the research endpoints: presigned 1 h link to the source PDF (issue FunderMapsApi#140)
├── auth.ts         # API key middleware (Bearer only; dual-stack UNION ALL across auth_key + apikey)
├── geocoder.ts     # ID format detection + resolution functions
├── enums.ts        # Canonical enum label sets mirroring pg_enum; doc/db sync checked by enums.test.ts (issue #996)
├── rate-limit.ts   # Per-(key, product) calendar-window rate limit middleware
├── risk.ts         # Pure overallRisk computation for /v4/product/light
├── health.ts       # Readiness probe for /v4/health: cached, timeout-bounded SELECT 1
├── tracker.ts      # After-response product tracking middleware
├── mcp.ts          # POST /v4/mcp — MCP server; tools dispatch in-process to the product routes
└── routes/
    ├── product.ts  # analysis/risk/light + facade_scan/foundation-research + statistics endpoints
    ├── health.ts   # GET /v4/health — 200 ok / 503 service_unavailable
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
