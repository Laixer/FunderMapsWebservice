import { Hono } from "hono";
import { logger } from "hono/logger";
import { clampId, errorJson } from "./errors.ts";
import { env } from "./config.ts";
import { sql } from "./db.ts";
import { authMiddleware } from "./auth.ts";
import { trackerMiddleware } from "./tracker.ts";
import productRoutes from "./routes/product.ts";
import usageRoutes from "./routes/usage.ts";

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

const app = new Hono<AppEnv>();

app.use("*", logger());

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
