import { createMiddleware } from "hono/factory";
import { sql } from "./db.ts";
import type { AppEnv } from "./index.ts";

export const trackerMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  await next();

  const tracker = c.get("tracker");
  if (!tracker) return;

  try {
    await sql`
      INSERT INTO application.product_tracker (organization_id, product, building_id, identifier)
      SELECT ${tracker.tenantId}, ${tracker.product}, ${tracker.buildingId}, ${tracker.identifier}
      WHERE NOT EXISTS (
        SELECT 1 FROM application.product_tracker
        WHERE organization_id = ${tracker.tenantId}
          AND product = ${tracker.product}
          AND building_id = ${tracker.buildingId}
          AND create_date > CURRENT_TIMESTAMP - interval '24 hours'
      )
    `;
  } catch {
    // Tracking failure must never break the response
  }
});
