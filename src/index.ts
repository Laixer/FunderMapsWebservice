import { Hono } from "hono";
import { logger } from "hono/logger";
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
  return c.json({ message: "Internal server error" }, 500);
});

app.get("/health", (c) => c.json({ status: "ok" }));

app.use("/v4/product/*", authMiddleware, trackerMiddleware);
app.route("/v4/product", productRoutes);

app.use("/v4/usage/*", authMiddleware);
app.route("/v4/usage", usageRoutes);

app.notFound((c) => c.json({ message: "Not found" }, 404));

export default {
  port: env.PORT,
  fetch: app.fetch,
};
