import { Hono } from "hono";
import { logger } from "hono/logger";
import { env } from "./config.ts";
import { authMiddleware } from "./auth.ts";
import { trackerMiddleware } from "./tracker.ts";
import productRoutes from "./routes/product.ts";

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

app.use("/api/v3/product/*", authMiddleware, trackerMiddleware);
app.route("/api/v3/product", productRoutes);

app.notFound((c) => c.json({ message: "Not found" }, 404));

export default {
  port: env.PORT,
  fetch: app.fetch,
};
