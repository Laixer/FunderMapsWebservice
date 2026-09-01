import { Hono } from "hono";
import { errorJson } from "../errors.ts";

// Public readiness endpoint — see src/health.ts for why it exists next to
// /health. The HTTP status is the contract consumers key on: 200 = available,
// anything else = unavailable. The body says nothing technical on purpose
// (no versions, hostnames, timings): the endpoint is anonymous.
//
// Mounted outside /v4/product/* so neither authMiddleware nor
// trackerMiddleware ever sees it: a health poll is never a billable event.

export function healthRoutes(ready: () => Promise<boolean>) {
  const health = new Hono();

  health.get("/", async (c) => {
    // Cloudflare and the DO edge sit in front of us; a cached "ok" would
    // defeat the point.
    c.header("Cache-Control", "no-store");
    if (await ready()) return c.json({ status: "ok" });
    return errorJson(
      c,
      503,
      "service_unavailable",
      "The webservice is temporarily unavailable. Retry later.",
    );
  });

  return health;
}
