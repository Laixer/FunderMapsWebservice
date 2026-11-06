// Per-(organization, product) billing-event rate limiting for /v4/product/*
// (issues #8, #16). The unit being limited is "billable events" — rows in
// application.product_tracker, post-dedup. A customer hitting the same
// building 100× within 24h produces one tracker row and so consumes
// one unit, matching the pricing model.
//
// Limits live in application.organization_rate_limit, one row per
// (organization, product) pair, so every key of an organization shares them.
// Absence of a row = unlimited. Period is calendar-aligned UTC (resets at UTC
// midnight for 'day', first-of-month UTC for 'month').
//
// The count comes from application.product_tracker_count, which a trigger on
// product_tracker keeps per UTC day: at most 31 rows to read, whatever the
// customer's volume.
//
// Behaviour on overage: 429 + Retry-After + X-RateLimit-* headers + a
// structured log line for monitoring pipelines.

import { createMiddleware } from "hono/factory";
import { sql } from "./db.ts";
import { errorJson } from "./errors.ts";
import type { AppEnv } from "./index.ts";

export type RateLimitPeriod = "day" | "month";

export interface RateLimitConfig {
  period: RateLimitPeriod;
  limit: number;
}

interface CachedConfig {
  config: RateLimitConfig | null;
  expiresAt: number;
}

const CONFIG_TTL_MS = 60_000;
const configCache = new Map<string, CachedConfig>();

function cacheKey(tenantId: string, product: string): string {
  return `${tenantId}|${product}`;
}

export function clearRateLimitCache(): void {
  configCache.clear();
}

// Calendar-aligned UTC window start. 'day' → today at 00:00 UTC; 'month'
// → first day of this month at 00:00 UTC.
export function windowStart(period: RateLimitPeriod, now: Date): Date {
  if (period === "day") {
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// Seconds until the next window starts. Used for Retry-After / X-RateLimit-Reset.
// Minimum 1 to keep the header well-formed even at the exact boundary.
export function secondsUntilReset(period: RateLimitPeriod, now: Date): number {
  const reset =
    period === "day"
      ? new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + 1,
          ),
        )
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return Math.max(1, Math.ceil((reset.getTime() - now.getTime()) / 1000));
}

export interface RateLimitVerdict {
  allowed: boolean;
  remaining: number;
}

export function decide(
  config: RateLimitConfig,
  countInWindow: number,
): RateLimitVerdict {
  return {
    allowed: countInWindow < config.limit,
    remaining: Math.max(0, config.limit - countInWindow),
  };
}

async function resolveConfig(
  tenantId: string,
  product: string,
): Promise<RateLimitConfig | null> {
  const now = Date.now();
  const key = cacheKey(tenantId, product);
  const cached = configCache.get(key);
  if (cached && cached.expiresAt > now) return cached.config;

  const rows = await sql`
    SELECT period, limit_count
    FROM application.organization_rate_limit
    WHERE organization_id = ${tenantId}
      AND product = ${product}
  `;

  const config: RateLimitConfig | null =
    rows.length === 0
      ? null
      : {
          period: rows[0]!.period as RateLimitPeriod,
          limit: rows[0]!.limit_count as number,
        };

  configCache.set(key, { config, expiresAt: now + CONFIG_TTL_MS });
  return config;
}

async function countInWindow(
  tenantId: string,
  product: string,
  since: Date,
): Promise<number> {
  // `since` is 00:00 UTC, so its date is the first day of the window.
  const rows = await sql`
    SELECT coalesce(sum(count), 0)::int AS count
    FROM application.product_tracker_count
    WHERE organization_id = ${tenantId}
      AND product = ${product}
      AND day >= ${since.toISOString().slice(0, 10)}
  `;
  return (rows[0]?.count as number) ?? 0;
}

export const rateLimit = (product: string) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const apiKeyId = c.get("apiKeyId");
    const apiKeySource = c.get("apiKeySource");
    const tenantId = c.get("tenantId");
    // authMiddleware always sets this before we run; guard anyway so a
    // misconfigured route ordering can't turn a 429 into a 500.
    if (!tenantId) return next();

    const config = await resolveConfig(tenantId, product);
    if (!config) return next();

    const now = new Date();
    const since = windowStart(config.period, now);
    const count = await countInWindow(tenantId, product, since);
    const verdict = decide(config, count);

    c.header("X-RateLimit-Limit", String(config.limit));
    c.header("X-RateLimit-Remaining", String(verdict.remaining));
    c.header(
      "X-RateLimit-Reset",
      String(Math.floor(now.getTime() / 1000) + secondsUntilReset(config.period, now)),
    );

    if (!verdict.allowed) {
      const retryAfter = secondsUntilReset(config.period, now);
      c.header("Retry-After", String(retryAfter));
      // Structured one-line JSON so journald/logflow can pick it up.
      console.log(
        JSON.stringify({
          event: "rate_limit_exceeded",
          tenantId,
          apiKeyId,
          apiKeySource,
          product,
          period: config.period,
          limit: config.limit,
          count,
        }),
      );
      return errorJson(
        c,
        429,
        "rate_limit_exceeded",
        `Rate limit exceeded for product '${product}': ${config.limit} per ${config.period}. Retry after ${retryAfter} seconds.`,
      );
    }

    return next();
  });
