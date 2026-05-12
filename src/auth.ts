import { createMiddleware } from "hono/factory";
import { sql } from "./db.ts";
import type { AppEnv } from "./index.ts";

interface AuthResult {
  userId: string;
  tenantId: string;
  expiresAt: number;
}

const AUTH_TTL_MS = 60_000;
const cache = new Map<string, AuthResult>();

function extractKey(c: { req: { header: (name: string) => string | undefined } }): string | null {
  const authHeader = c.req.header("Authorization");
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(\S.*)$/i);
    if (match) return match[1]!.trim();
  }

  return null;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// SHA-256 → base64url with NO padding. Matches the storage format used
// by the @better-auth/api-key plugin's defaultKeyHasher
// (node_modules/@better-auth/api-key/dist/index.mjs ~line 2030):
//   `base64Url.encode(new Uint8Array(hash), { padding: false })`.
// Different format from the legacy hex; the dual-read SQL below uses
// both because plaintext can only live in one of the two tables.
async function sha256Base64Url(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Buffer.from(new Uint8Array(buf)).toString("base64url");
}

async function resolveKey(key: string): Promise<AuthResult | null> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached;

  // Dual-read across both api-key tables in a single round-trip.
  // - application.auth_key:   legacy table, SHA-256 hex hashes. Holds
  //   every key issued before the @better-auth/api-key plugin landed.
  //   C# Webservice still reads this directly until Dec 2026; we keep
  //   honoring those keys here too.
  // - application.apikey:     Better Auth's plugin table, SHA-256
  //   base64url-no-padding hashes. New keys created via the TS API's
  //   management routes (Phase B.3) land here.
  //
  // One plaintext only ever matches one table, so UNION ALL + LIMIT 1
  // returns at most one row. The `source` column tells the fire-and-
  // forget last-used update which table to hit. Indexes on
  // auth_key.key_hash and apikey.key make both branches B-tree
  // point-lookups.
  //
  // Phase B.2 of the apiKey migration plan; see
  // ~/.claude/projects/-home-exedev/memory/project_better_auth_migration.md.
  // We deliberately avoid pulling Better Auth in as a dependency on
  // this billable surface — the SQL inline above is cheaper and the
  // verification logic is fully expressible in our existing stack.
  const [keyHashHex, keyHashB64Url] = await Promise.all([
    sha256Hex(key),
    sha256Base64Url(key),
  ]);
  const rows = await sql`
    SELECT ak.user_id, ou.organization_id, 'legacy' AS source
    FROM application.auth_key ak
    JOIN application.organization_user ou ON ou.user_id = ak.user_id
    WHERE ak.key_hash = ${keyHashHex}
    UNION ALL
    SELECT ak.reference_id AS user_id, ou.organization_id, 'ba' AS source
    FROM application.apikey ak
    JOIN application.organization_user ou ON ou.user_id = ak.reference_id
    WHERE ak.key = ${keyHashB64Url}
      AND ak.enabled IS NOT FALSE
      AND (ak.expires_at IS NULL OR ak.expires_at > now())
    LIMIT 1
  `;

  if (rows.length === 0) return null;

  // Fire-and-forget usage bump on the matching table. Cache miss only —
  // bounded to once per AUTH_TTL_MS per key, so this won't hammer the
  // tables on hot keys. Errors are non-fatal: usage tracking is
  // observability, not auth.
  if (rows[0]!.source === "ba") {
    sql`UPDATE application.apikey
        SET last_request = now(),
            request_count = COALESCE(request_count, 0) + 1
        WHERE key = ${keyHashB64Url}`.catch(() => {});
  } else {
    sql`UPDATE application.auth_key
        SET last_used = now()
        WHERE key_hash = ${keyHashHex}`.catch(() => {});
  }

  const result: AuthResult = {
    userId: rows[0]!.user_id,
    tenantId: rows[0]!.organization_id,
    expiresAt: now + AUTH_TTL_MS,
  };

  cache.set(key, result);
  return result;
}

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const key = extractKey(c);
  if (!key) return c.json({ message: "Unauthorized" }, 401);

  const auth = await resolveKey(key);
  if (!auth) return c.json({ message: "Unauthorized" }, 401);

  c.set("userId", auth.userId);
  c.set("tenantId", auth.tenantId);
  return next();
});
