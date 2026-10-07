import { createMiddleware } from "hono/factory";
import { sql } from "./db.ts";

/**
 * A version stamp on every product delivery (issue #47).
 *
 * An integrator stores our answer per address and needs to tell one delivery
 * from the next. The answer can change without anything being reported on the
 * pand itself: the model is recalculated every night and takes neighbouring
 * panden into account. So every delivery says which model produced it and when
 * that model run finished. Equal `calculatedAt` = the same inputs, the same
 * answer.
 *
 *   modelVersion  the default model's slug (data.model_version.is_default),
 *                 which is what data.model_risk_static serves; today model-2024.1
 *   calculatedAt  when the last successful model refresh finished
 *                 (data.refresh_log, job refresh_data_model, status ok), ISO 8601 UTC
 *
 * Both values are the same for every pand until the next refresh, so they are
 * read once a minute, not per request. This is a mission-critical surface:
 * when the lookup fails the delivery goes out without a stamp, never as an
 * error, and the last good value is kept.
 */

export interface DeliveryVersion {
  modelVersion: string;
  calculatedAt: string;
}

const TTL_MS = 60_000;
let cached: { value: DeliveryVersion | null; at: number } | null = null;

export async function loadVersion(): Promise<DeliveryVersion | null> {
  const rows = await sql`
    SELECT
      (SELECT slug FROM data.model_version WHERE is_default ORDER BY id DESC LIMIT 1) AS slug,
      (SELECT max(finished_at) FROM data.refresh_log
        WHERE job = 'refresh_data_model' AND status = 'ok') AS at
  `;
  const row = rows[0] as { slug: string | null; at: Date | string | null } | undefined;
  if (!row?.slug || !row.at) return null;
  const at = row.at instanceof Date ? row.at : new Date(row.at);
  if (Number.isNaN(at.getTime())) return null;
  return { modelVersion: row.slug, calculatedAt: at.toISOString() };
}

let loader: () => Promise<DeliveryVersion | null> = loadVersion;

/** Tests that mock db.sql with an ordered queue swap the lookup out so it does not consume their rows. */
export function setVersionLoader(f: () => Promise<DeliveryVersion | null>) {
  loader = f;
  cached = null;
}

export async function currentVersion(now = Date.now()): Promise<DeliveryVersion | null> {
  if (cached && now - cached.at < TTL_MS) return cached.value;
  let value = cached?.value ?? null;
  try {
    value = (await loader()) ?? value;
  } catch (err) {
    console.error("delivery version lookup failed; serving without a stamp", err);
  }
  cached = { value, at: now };
  return value;
}

/** Tests only. */
export function resetVersionCache() {
  cached = null;
}

/** The header form: `model-2024.1@2026-10-06T19:59:49.000Z`. */
export const VERSION_HEADER = "X-FunderMaps-Version";

/**
 * Stamps a product response after the handler ran: the header on every
 * response, the two body fields on a 200 JSON object (never on an error body,
 * never on an array).
 */
export const versionMiddleware = createMiddleware(async (c, next) => {
  await next();
  const v = await currentVersion();
  if (!v) return;

  const headers = new Headers(c.res.headers);
  headers.set(VERSION_HEADER, `${v.modelVersion}@${v.calculatedAt}`);

  // Read the body once, as text: re-wrapping a stream that was tee'd by
  // clone() breaks in Bun. Only a 200 JSON body is read at all.
  let body: ReadableStream<Uint8Array> | string | null = c.res.body;
  if (c.res.status === 200 && (headers.get("content-type") ?? "").includes("application/json")) {
    const text = await c.res.text();
    body = text;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON after all: pass the text through unchanged
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = JSON.stringify({ ...parsed, modelVersion: v.modelVersion, calculatedAt: v.calculatedAt });
    }
    headers.delete("content-length");
  }
  c.res = new Response(body, { status: c.res.status, statusText: c.res.statusText, headers });
});
