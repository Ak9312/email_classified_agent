/**
 * GET /api/cron/renew-watch — daily Vercel Cron (spec §6.2).
 *   1. check Authorization: Bearer CRON_SECRET
 *   2. renew the Gmail watch (watches expire after 7 days)
 *   3. sweep: same classify loop with a longer lookback (catches failures and missed pushes)
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getConfig, log } from "../../lib/config";
import { startWatch } from "../../lib/gmail";
import { processInbox, type ProcessCounters } from "../../lib/process";
import { isValidCronAuth } from "../../lib/webhook-auth";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).setHeader("Allow", "GET").end();
    return;
  }

  let config;
  try {
    config = getConfig();
  } catch (err) {
    log("config_error", { path: "/api/cron/renew-watch", detail: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "config error, see logs" });
    return;
  }

  if (!isValidCronAuth(req.headers.authorization, config.cronSecret)) {
    log("auth_failed", { path: "/api/cron/renew-watch" });
    res.status(401).end();
    return;
  }

  let watchExpiration: string | null = null;
  let watchError: string | null = null;
  try {
    const w = await startWatch(config.pubsubTopic);
    watchExpiration = w.expiration;
    log("watch_renewed", { expiration: w.expiration });
  } catch (err) {
    watchError = err instanceof Error ? err.message : String(err);
    log("watch_failed", { detail: watchError });
  }

  // Sweep runs even if the renewal failed.
  let counters: ProcessCounters | null = null;
  let sweepError: string | null = null;
  try {
    counters = await processInbox({ lookbackDays: config.sweepLookbackDays, trigger: "cron" });
  } catch (err) {
    sweepError = err instanceof Error ? err.message : String(err);
    log("run_failed", { trigger: "cron", detail: sweepError });
  }

  const ok = !watchError && !sweepError;
  res.status(ok ? 200 : 500).json({
    watchExpiration,
    processed: counters?.processed ?? 0,
    labeled: counters?.labeled ?? 0,
    failed: counters?.failed ?? 0,
    skipped: counters?.skipped ?? 0,
    deferred: counters?.deferred ?? 0,
    ...(watchError ? { watchError } : {}),
    ...(sweepError ? { sweepError } : {}),
  });
}
