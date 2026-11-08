/**
 * POST /api/gmail-push?key=WEBHOOK_SECRET — Pub/Sub push endpoint (spec §6.1).
 *
 * Response codes:
 *   401  wrong/missing key (no Gmail work done)
 *   405  not a POST
 *   204  done (including "nothing to do", per-message failures, or leftovers deferred by the time budget)
 *   500  config error or Gmail failure BEFORE any message was processed (Pub/Sub will redeliver)
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getConfig, log } from "../lib/config";
import { processInbox } from "../lib/process";
import { isValidWebhookKey } from "../lib/webhook-auth";

function sourceIp(req: VercelRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  return (Array.isArray(fwd) ? fwd[0] : (fwd ?? "")).split(",")[0].trim();
}

/** Decodes message.data → { emailAddress, historyId }. Returns null when malformed. */
export function parsePushBody(body: unknown): { emailAddress: string; historyId: string } | null {
  try {
    const obj = typeof body === "string" ? JSON.parse(body) : body;
    const data = (obj as { message?: { data?: unknown } })?.message?.data;
    if (typeof data !== "string") return null;
    const decoded = JSON.parse(Buffer.from(data, "base64").toString("utf8")) as { emailAddress?: unknown; historyId?: unknown };
    if (typeof decoded.emailAddress !== "string") return null;
    return { emailAddress: decoded.emailAddress.toLowerCase(), historyId: String(decoded.historyId ?? "") };
  } catch {
    return null;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).setHeader("Allow", "POST").end();
    return;
  }

  let config;
  try {
    config = getConfig();
  } catch (err) {
    log("config_error", { path: "/api/gmail-push", detail: err instanceof Error ? err.message : String(err) });
    res.status(500).end();
    return;
  }

  // Never log req.url or req.query: they contain the secret.
  if (!isValidWebhookKey(req.query.key, config.webhookSecret)) {
    log("auth_failed", { path: "/api/gmail-push", ip: sourceIp(req) });
    res.status(401).end();
    return;
  }

  const push = parsePushBody(req.body);
  if (!push) {
    log("push_ignored", { reason: "malformed body" });
    res.status(204).end(); // don't let Pub/Sub retry a malformed message forever
    return;
  }
  if (push.emailAddress !== config.gmailAddress) {
    log("push_ignored", { reason: "unexpected emailAddress", emailAddress: push.emailAddress });
    res.status(204).end();
    return;
  }

  // The push's historyId is intentionally ignored: the stateless label search finds the work (spec D2).
  try {
    await processInbox({ lookbackDays: config.pushLookbackDays, trigger: "push" });
  } catch (err) {
    log("run_failed", { trigger: "push", detail: err instanceof Error ? err.message : String(err) });
    res.status(500).end();
    return;
  }
  res.status(204).end();
}
