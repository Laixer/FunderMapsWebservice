// Readiness probe behind GET /v4/health (issue Laixer/FunderMaps#1014).
//
// Two health endpoints, on purpose:
//   /health     — liveness, no dependencies. DigitalOcean's probes hit it
//                 container-direct (the /v4 ingress rule never routes it to
//                 the public internet). It must not fail on a database blip,
//                 or the platform restarts a perfectly good process.
//   /v4/health  — readiness, public, unauthenticated. Answers the question
//                 consumers (NWWI, banks) actually have — "can the webservice
//                 serve a product request right now?" — so it pings the DB.
//
// The endpoint is anonymous, so the probe is deliberately cheap and bounded:
// one `SELECT 1` through the pool, a hard timeout, and the verdict cached for
// HEALTH_CACHE_MS. However often a monitor polls, the database sees at most
// one probe per window, and concurrent callers share one in-flight probe.
// A *failed* verdict is cached too — a database that is already down is not
// the one to hammer.

import { sql } from "./db.ts";

export const HEALTH_CACHE_MS = 5_000;
export const HEALTH_PROBE_TIMEOUT_MS = 2_000;

export type ReadinessOptions = {
  /** Resolves when the dependency answered; rejects (or hangs) when it didn't. */
  probe: () => Promise<unknown>;
  cacheMs?: number;
  timeoutMs?: number;
  now?: () => number;
  /** Called on every transition between available and unavailable. */
  onChange?: (ok: boolean) => void;
};

export function createReadinessCheck({
  probe,
  cacheMs = HEALTH_CACHE_MS,
  timeoutMs = HEALTH_PROBE_TIMEOUT_MS,
  now = Date.now,
  onChange,
}: ReadinessOptions): () => Promise<boolean> {
  let verdict: { ok: boolean; at: number } | undefined;
  let inflight: Promise<boolean> | undefined;

  return () => {
    if (verdict && now() - verdict.at < cacheMs) return Promise.resolve(verdict.ok);
    if (inflight) return inflight;

    inflight = withTimeout(probe(), timeoutMs)
      .then(
        () => true,
        () => false,
      )
      .then((ok) => {
        // A healthy start is the expected state and not worth a log line;
        // starting unavailable is.
        const was = verdict?.ok ?? true;
        if (was !== ok) onChange?.(ok);
        verdict = { ok, at: now() };
        inflight = undefined;
        return ok;
      });
    return inflight;
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`probe timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export const databaseReady = createReadinessCheck({
  probe: () => sql`SELECT 1`,
  onChange: (ok) =>
    console.log(
      JSON.stringify({
        event: ok ? "health_recovered" : "health_unavailable",
        at: new Date().toISOString(),
      }),
    ),
});
