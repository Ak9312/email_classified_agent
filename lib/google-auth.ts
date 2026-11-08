/** OAuth2 client for the job-application Gmail account, built from the stored refresh token. */
import { OAuth2Client } from "google-auth-library";
import type { AppConfig } from "./config";

/** Narrowest scope that can apply labels; it cannot permanently delete mail (spec §8). */
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

export function createOAuthClient(config: Pick<AppConfig, "googleClientId" | "googleClientSecret" | "googleRefreshToken">): OAuth2Client {
  const client = new OAuth2Client({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
  });
  client.setCredentials({ refresh_token: config.googleRefreshToken });
  return client;
}
