// Structured error contract for every non-200 response.
//
// Body shape: { code, message }. `code` is a stable, machine-readable
// string clients can switch on; `message` is human-readable and may be
// reworded without notice. The top-level `message` field predates `code`,
// so existing consumers that parse { message } keep working.
//
// Add new codes here rather than inlining strings in handlers — the type
// union is the canonical list of what clients can encounter.

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// The 404 family maps onto the follow-up actions consumers need to
// automate (issue Laixer/FunderMaps#1002, NWWI): identifier_invalid /
// address_not_found → resubmit with a corrected identifier;
// building_not_found / not_a_building → no follow-up (a QuickScan is
// pointless); no_data_available → request a QuickScan;
// internal_server_error → retry later.
//
// Every code must appear in the MIGRATION.md error-responses table —
// errors.test.ts enforces the sync.
export const ERROR_CODES = [
  "missing_api_key", // 401 — no Authorization: Bearer header
  "invalid_api_key", // 401 — key unknown, disabled, or expired
  "identifier_invalid", // 404 — :id isn't a recognized identifier format
  "address_not_found", // 404 — valid BAG address format, but unknown in BAG
  "building_not_found", // 404 — valid BAG pand id, but no such building in BAG
  "not_a_building", // 404 — id points at a ligplaats/standplaats (houseboat/mobile home)
  "no_data_available", // 404 — building exists, but no foundation data for it
  "neighborhood_not_found", // 404 — statistics: unknown CBS neighborhood code
  "rate_limit_exceeded", // 429 — per-(key, product) billing-event limit hit
  "route_not_found", // 404 — unknown endpoint
  "internal_server_error", // 500 — unhandled exception
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function errorJson(
  c: Context,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
) {
  return c.json({ code, message }, status);
}

// Client-supplied identifiers get echoed back in 404 messages for
// debuggability; clamp them so an absurd path segment can't balloon the
// response or the logs.
export function clampId(id: string, max = 64): string {
  return id.length <= max ? id : `${id.slice(0, max)}…`;
}
