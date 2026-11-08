/**
 * Starts (or renews) the Gmail push watch — the same thing the daily cron does in step 2.
 * Needs the Google variables and PUBSUB_TOPIC (plus the rest of the config) in .env.local.
 *
 *   npm run start-watch
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig } from "../lib/config";
import { resolveLabelIds, startWatch } from "../lib/gmail";

async function main(): Promise<void> {
  const envPath = resolve(__dirname, "..", ".env.local");
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const config = getConfig();

  // Also checks that the four labels exist with the exact names.
  const labels = await resolveLabelIds();
  console.log("Found all four labels:", Object.keys(labels).join(", "));

  const w = await startWatch(config.pubsubTopic);
  console.log(`Watch active on INBOX → ${config.pubsubTopic}`);
  console.log(`Expires: ${w.expiration} (the daily cron renews it automatically)`);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  if (/permission|forbidden|403/i.test(msg)) {
    console.error(
      "\nHint: give gmail-api-push@system.gserviceaccount.com the Pub/Sub Publisher role on your topic (README step 4).",
    );
  }
  process.exit(1);
});
