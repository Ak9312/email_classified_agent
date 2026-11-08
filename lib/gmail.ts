/**
 * The ONLY module that talks to the Gmail API (spec §9).
 *
 * Exactly one function changes anything in Gmail: addLabel(), which can only ADD one of the four
 * classifier labels to a message. Nothing here deletes, trashes, archives, marks as read, removes
 * labels, sends mail, or creates/edits labels — and test/safety.test.ts fails the build if such
 * calls ever appear in the code.
 */
import { google, type gmail_v1 } from "googleapis";
import { CATEGORIES, GMAIL_LABEL_NAMES, LIST_MAX_RESULTS, getConfig, type Category } from "./config";
import { createOAuthClient } from "./google-auth";

export type LabelIds = Record<Category, string>;

let client: gmail_v1.Gmail | undefined;
let labelIdCache: LabelIds | undefined;

function gmail(): gmail_v1.Gmail {
  if (!client) client = google.gmail({ version: "v1", auth: createOAuthClient(getConfig()) });
  return client;
}

/** Test hook: inject a fake Gmail client and reset the label cache. */
export function __setGmailClientForTests(fake: unknown, labelIds?: LabelIds): void {
  client = fake as gmail_v1.Gmail;
  labelIdCache = labelIds;
}

/**
 * Looks up the IDs of the four labels by EXACT name. Throws if any is missing — the system never
 * creates labels. Cached per warm instance.
 */
export async function resolveLabelIds(): Promise<LabelIds> {
  if (labelIdCache) return labelIdCache;
  const res = await gmail().users.labels.list({ userId: "me" });
  const labels = res.data.labels ?? [];
  const ids: Partial<LabelIds> = {};
  const missing: string[] = [];
  for (const category of CATEGORIES) {
    const name = GMAIL_LABEL_NAMES[category];
    const found = labels.find((l) => l.name === name);
    if (found?.id) ids[category] = found.id;
    else missing.push(name);
  }
  if (missing.length) {
    const available = labels.filter((l) => l.type === "user").map((l) => l.name);
    throw new Error(
      `Gmail label(s) not found: ${missing.map((m) => JSON.stringify(m)).join(", ")}. ` +
        `User labels in this account: ${available.map((m) => JSON.stringify(m)).join(", ") || "(none)"}. ` +
        `Create them in Gmail, or fix GMAIL_LABEL_NAMES in lib/config.ts.`,
    );
  }
  labelIdCache = ids as LabelIds;
  return labelIdCache;
}

/** IDs of recent inbox messages not sent by me, newest first (spec §6.3 step 2). */
export async function listCandidates(lookbackDays: number): Promise<string[]> {
  const res = await gmail().users.messages.list({
    userId: "me",
    q: `in:inbox newer_than:${lookbackDays}d -from:me`,
    maxResults: LIST_MAX_RESULTS,
  });
  return (res.data.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
}

export async function getMessage(id: string, format: "full" | "minimal" = "full"): Promise<gmail_v1.Schema$Message> {
  const res = await gmail().users.messages.get({ userId: "me", id, format });
  return res.data;
}

/**
 * The ONLY write. Adds exactly one of the four classifier labels to a message.
 * The request body contains addLabelIds and nothing else.
 */
export async function addLabel(messageId: string, labelId: string): Promise<void> {
  const allowed = labelIdCache ? Object.values(labelIdCache) : [];
  if (!allowed.includes(labelId)) {
    throw new Error(`Refusing to add label ${JSON.stringify(labelId)}: not one of the four classifier labels.`);
  }
  await gmail().users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { addLabelIds: [labelId] },
  });
}

/** Starts or renews the Gmail push watch on INBOX (lasts 7 days). Returns the expiry time. */
export async function startWatch(topicName: string): Promise<{ historyId: string; expiration: string }> {
  const res = await gmail().users.watch({
    userId: "me",
    requestBody: { topicName, labelIds: ["INBOX"], labelFilterBehavior: "include" },
  });
  const ms = Number(res.data.expiration);
  return {
    historyId: String(res.data.historyId ?? ""),
    expiration: Number.isFinite(ms) ? new Date(ms).toISOString() : String(res.data.expiration ?? ""),
  };
}
