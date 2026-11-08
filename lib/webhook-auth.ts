/** Constant-time shared-secret checks for the push endpoint (?key=) and the cron endpoint (Bearer). */
import { timingSafeEqual } from "node:crypto";

/** Constant-time string comparison. Different lengths return false without comparing contents. */
export function safeEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Checks the `key` query parameter of a Pub/Sub push request against WEBHOOK_SECRET. */
export function isValidWebhookKey(key: string | string[] | undefined | null, secret: string): boolean {
  if (!secret) return false;
  if (typeof key !== "string" || key.length === 0) return false; // missing, or repeated (?key=a&key=b)
  return safeEqual(key, secret);
}

/** Checks `Authorization: Bearer <CRON_SECRET>` sent by Vercel Cron. */
export function isValidCronAuth(authorization: string | string[] | undefined | null, secret: string): boolean {
  if (!secret) return false;
  if (typeof authorization !== "string") return false;
  return safeEqual(authorization, `Bearer ${secret}`);
}
