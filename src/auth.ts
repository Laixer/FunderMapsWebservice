import { createMiddleware } from "hono/factory";
import { sql } from "./db.ts";
import type { AppEnv } from "./index.ts";

function extractKey(c: { req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined } }): string | null {
  // 1. Authorization: Bearer fmsk.xxx (preferred)
  // 2. Authorization: authkey fmsk.xxx (legacy)
  const authHeader = c.req.header("Authorization");
  if (authHeader) {
    if (authHeader.startsWith("Bearer ")) return authHeader.slice(7);
    if (authHeader.startsWith("authkey ")) return authHeader.slice(8);
  }

  // 3. X-API-Key header
  const apiKey = c.req.header("X-API-Key");
  if (apiKey) return apiKey;

  // 4. Query param (legacy)
  const queryKey = c.req.query("authkey");
  if (queryKey) return queryKey;

  return null;
}

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const key = extractKey(c);
  if (!key) return c.json({ message: "Unauthorized" }, 401);

  const rows = await sql`
    SELECT ak.user_id, ou.organization_id
    FROM application.auth_key ak
    JOIN application.organization_user ou ON ou.user_id = ak.user_id
    WHERE ak.key = ${key}
    LIMIT 1
  `;

  if (rows.length === 0) return c.json({ message: "Unauthorized" }, 401);

  c.set("userId", rows[0]!.user_id);
  c.set("tenantId", rows[0]!.organization_id);
  return next();
});
