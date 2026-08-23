import { Hono } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { clampId, errorJson } from "./errors.ts";
import { env } from "./config.ts";
import { sql } from "./db.ts";
import { authMiddleware } from "./auth.ts";
import { trackerMiddleware } from "./tracker.ts";
import productRoutes from "./routes/product.ts";
import usageRoutes from "./routes/usage.ts";
import { mcpHandler } from "./mcp.ts";

const shutdown = async () => {
  console.log("Shutting down...");
  await sql.end({ timeout: 5 });
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export type AppEnv = {
  Variables: {
    userId: string;
    tenantId: string;
    apiKeyId: string;
    apiKeySource: "ba" | "legacy";
    tracker?: {
      tenantId: string;
      product: string;
      buildingId: string;
      identifier: string;
    };
  };
};

export const app = new Hono<AppEnv>();

app.use("*", logger());

// Security response headers — HSTS, nosniff, frame-options, referrer-policy.
// Same call as FunderMapsApi's middleware stack, deliberately kept identical
// so both surfaces answer with the same header set.
//
// Safe on this surface: every consumer is server-to-server (API-key auth, no
// CORS middleware, so browsers can't call us cross-origin anyway), and these
// headers are browser-enforced only — they change no response body and no
// status code. In particular `cross-origin-resource-policy: same-origin` does
// not affect server-side callers like the banks/NWWI integrations.
app.use("*", secureHeaders());

app.onError((err, c) => {
  console.error(err);
  return errorJson(
    c,
    500,
    "internal_server_error",
    "An unexpected error occurred. If the problem persists, contact FunderMaps support.",
  );
});

app.get("/health", (c) => c.json({ status: "ok" }));

app.use("/v4/product/*", authMiddleware, trackerMiddleware);
app.route("/v4/product", productRoutes);

app.use("/v4/usage/*", authMiddleware);
app.route("/v4/usage", usageRoutes);

// MCP endpoint (Streamable HTTP, stateless). Auth runs here so callers get the
// same JSON 401 as every other route; billing/rate limits run inside the
// in-process dispatch to the product routes — see src/mcp.ts.
app.use("/v4/mcp", authMiddleware);
app.all("/v4/mcp", mcpHandler(app));

app.notFound((c) =>
  errorJson(
    c,
    404,
    "route_not_found",
    `Unknown endpoint: ${c.req.method} ${clampId(new URL(c.req.url).pathname)}`,
  ),
);

export default {
  port: env.PORT,
  fetch: app.fetch,
};
