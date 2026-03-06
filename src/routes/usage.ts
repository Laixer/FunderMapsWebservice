import { Hono } from "hono";
import { sql } from "../db.ts";
import type { AppEnv } from "../index.ts";

const usage = new Hono<AppEnv>();

usage.get("/", async (c) => {
  const tenantId = c.get("tenantId");

  const [daily, monthly, total] = await Promise.all([
    sql`
      SELECT create_date::date AS date, count(*)::int AS count
      FROM application.product_tracker
      WHERE organization_id = ${tenantId}
        AND create_date >= CURRENT_DATE - interval '30 days'
      GROUP BY create_date::date
      ORDER BY date
    `,
    sql`
      SELECT date_trunc('month', create_date)::date AS month, count(*)::int AS count
      FROM application.product_tracker
      WHERE organization_id = ${tenantId}
        AND create_date >= date_trunc('year', CURRENT_DATE)
      GROUP BY date_trunc('month', create_date)
      ORDER BY month
    `,
    sql`
      SELECT count(*)::int AS count
      FROM application.product_tracker
      WHERE organization_id = ${tenantId}
    `,
  ]);

  return c.json({
    daily,
    monthly,
    total: total[0]?.count ?? 0,
  });
});

export default usage;
