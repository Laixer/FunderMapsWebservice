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

async function resolveKey(key: string): Promise<AuthResult | null> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached;

  // Hash-only lookup. The plaintext `key` column stays in DB for the
  // C# webservice on ws.fundermaps.com, which has its own auth path.
  // Every existing key was backfilled in phase 1 and every new key is
  // dual-written by the TS API management route.
  const keyHash = await sha256Hex(key);
  const rows = await sql`
    SELECT ak.user_id, ou.organization_id
    FROM application.auth_key ak
    JOIN application.organization_user ou ON ou.user_id = ak.user_id
    WHERE ak.key_hash = ${keyHash}
    LIMIT 1
  `;

  if (rows.length === 0) return null;

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
