# FunderMapsWebservice — Bun + Hono, read-only product API (/v4/product/*).
# Two stages so the runtime image carries only production node_modules and
# src/. No build step: Bun runs TypeScript directly.
#
#   docker build -t fundermaps-webservice .
#   docker run --rm -p 8080:8080 --env-file .env fundermaps-webservice
#
# Not used by DigitalOcean App Platform (webservice-prod/-staging have no
# dockerfile_path and build with buildpacks); this is the portable image for
# the v5 hosting move.

ARG BUN_VERSION=1.3
FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:${BUN_VERSION}-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
USER bun
EXPOSE 8080
# PORT defaults to 8080 in src/config.ts; override with -e PORT=... and match EXPOSE/-p.
# /health is the dependency-free liveness route (never leaves the container edge).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT ?? 8080}/health`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "run", "src/index.ts"]
