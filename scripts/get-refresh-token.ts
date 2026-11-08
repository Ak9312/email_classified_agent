/**
 * One-time: sign in as the job-application Gmail account and print a refresh token (spec §8).
 * Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (OAuth client of type "Desktop app") in .env.local.
 *
 *   npm run get-refresh-token
 */
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { OAuth2Client } from "google-auth-library";
import { GMAIL_SCOPES } from "../lib/google-auth";

async function main(): Promise<void> {
  const envPath = resolve(__dirname, "..", ".env.local");
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    console.error("Put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local first (see README step 2).");
    process.exit(1);
  }

  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });

  const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: GMAIL_SCOPES });
  console.log("\n1. Open this link in your browser:\n\n" + url + "\n");
  console.log("2. Sign in with your JOB-APPLICATION Gmail account (not your main one).");
  console.log('3. If you see "Google hasn\'t verified this app": click Advanced → Go to (app name) (unsafe). It is your own app.');
  console.log("4. Allow access. This window will then show your refresh token.\n");

  const code = await new Promise<string>((resolveCode, reject) => {
    server.on("request", (req, res) => {
      const u = new URL(req.url ?? "/", redirectUri);
      const c = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      if (err) {
        res.end("Sign-in was cancelled or failed. You can close this tab.");
        reject(new Error(`Google returned: ${err}`));
      } else if (c) {
        res.end("Done! You can close this tab and go back to the terminal.");
        resolveCode(c);
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  server.close();

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    console.error(
      "Google did not return a refresh token. Remove this app's access at https://myaccount.google.com/permissions (signed in as the job account) and run this again.",
    );
    process.exit(1);
  }
  if (tokens.scope && !tokens.scope.includes("gmail.modify")) {
    console.error(`Warning: granted scopes were "${tokens.scope}" — gmail.modify is missing. Make sure you ticked the Gmail permission.`);
  }
  console.log("Your refresh token (keep it secret):\n\n" + tokens.refresh_token + "\n");
  console.log("Put it in .env.local as GOOGLE_REFRESH_TOKEN=... and in Vercel as GOOGLE_REFRESH_TOKEN.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
