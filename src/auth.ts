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

function extractKey(c: { req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined } }): string | null {
  const authHeader = c.req.header("Authorization");
  if (authHeader) {
    if (authHeader.startsWith("Bearer ")) return authHeader.slice(7);
    if (authHeader.startsWith("authkey ")) return authHeader.slice(8);
  }

  const apiKey = c.req.header("X-API-Key");
  if (apiKey) return apiKey;

  const queryKey = c.req.query("authkey");
  if (queryKey) return queryKey;

  return null;
}

async function resolveKey(key: string): Promise<AuthResult | null> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached;

  const rows = await sql`
    SELECT ak.user_id, ou.organization_id
    FROM application.auth_key ak
    JOIN application.organization_user ou ON ou.user_id = ak.user_id
    WHERE ak.key = ${key}
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
