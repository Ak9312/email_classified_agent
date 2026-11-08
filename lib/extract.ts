/**
 * Turns a Gmail API message (format: "full") into the EmailFeatures the classifier uses (spec §7.1).
 * The same shape is used by the eval fixtures (spec §11.2).
 */
import { z } from "zod";
import { convert } from "html-to-text";
import type { gmail_v1 } from "googleapis";
import { BODY_MAX_CHARS } from "./config";

export const AUTOMATION_HEADERS = ["List-Unsubscribe", "List-Id", "Precedence", "Auto-Submitted"] as const;

export const AddressSchema = z.object({
  name: z.string(),
  address: z.string(),
});

export const EmailFeaturesSchema = z.object({
  from: AddressSchema,
  replyTo: AddressSchema.nullable(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  date: z.string(),
  headers: z
    .object({
      "List-Unsubscribe": z.string().optional(),
      "List-Id": z.string().optional(),
      Precedence: z.string().optional(),
      "Auto-Submitted": z.string().optional(),
    })
    .strict(),
  bodyText: z.string(),
  snippet: z.string(),
});

export type Address = z.infer<typeof AddressSchema>;
export type EmailFeatures = z.infer<typeof EmailFeaturesSchema>;

type Part = gmail_v1.Schema$MessagePart;

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string | undefined {
  const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? undefined;
}

/** "Riya Sharma <riya@x.com>" → { name, address }. Addresses are lowercased. */
export function parseAddress(raw: string | undefined): Address {
  if (!raw) return { name: "", address: "" };
  const trimmed = raw.trim();
  const m = trimmed.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  if (m) return { name: (m[1] ?? "").trim(), address: m[2].trim().toLowerCase() };
  return { name: "", address: trimmed.toLowerCase() };
}

/** Splits an address-list header on commas that are not inside quotes or angle brackets. */
export function splitAddressList(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  let inAngle = false;
  for (const ch of raw) {
    if (ch === '"') inQuote = !inQuote;
    else if (ch === "<") inAngle = true;
    else if (ch === ">") inAngle = false;
    if (ch === "," && !inQuote && !inAngle) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map((a) => parseAddress(a).address).filter(Boolean);
}

function decodeBase64Url(data: string | null | undefined): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** Depth-first search for the first body part of a given MIME type, skipping attachments. */
function findPart(part: Part | undefined, mimeType: string): Part | undefined {
  if (!part) return undefined;
  const isAttachment = Boolean(part.filename) || /attachment/i.test(header(part.headers, "Content-Disposition") ?? "");
  if (!isAttachment && part.mimeType?.toLowerCase() === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "script", format: "skip" },
    ],
  });
}

/** Removes quoted earlier messages ("On … wrote:", "> " lines, Outlook headers). */
export function stripQuotedReply(text: string): string {
  let t = text.replace(/\r\n?/g, "\n");
  const cutPatterns = [
    /\n[^\n]*\bOn\b[^\n]*(?:\n[^\n]*)?\bwrote:\s*(?:\n|$)/, // Gmail/Apple, sometimes wrapped over two lines
    /\n-{2,}\s*Original Message\s*-{2,}/i,
    /\n_{5,}\s*\nFrom:/, // Outlook separator
    /\nFrom:[^\n]*\n(?:Sent|Date):[^\n]*\n/, // Outlook header block
  ];
  for (const p of cutPatterns) {
    const m = t.match(p);
    if (m && m.index !== undefined) t = t.slice(0, m.index);
  }
  return t
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
}

/** Collapses runs of spaces and blank lines. */
export function collapseWhitespace(text: string): string {
  return text
    .replace(/ /g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function cleanBody(text: string, maxChars = BODY_MAX_CHARS): string {
  return collapseWhitespace(stripQuotedReply(text)).slice(0, maxChars);
}

export function extract(message: gmail_v1.Schema$Message): EmailFeatures {
  const payload = message.payload ?? {};
  const headers = payload.headers ?? [];

  const plain = findPart(payload, "text/plain");
  const html = findPart(payload, "text/html");
  let body = "";
  if (plain) body = decodeBase64Url(plain.body?.data);
  else if (html) body = htmlToText(decodeBase64Url(html.body?.data));

  const automation: EmailFeatures["headers"] = {};
  for (const name of AUTOMATION_HEADERS) {
    const v = header(headers, name);
    if (v !== undefined) automation[name] = v;
  }

  const replyToRaw = header(headers, "Reply-To");
  const internalDate = message.internalDate ? Number(message.internalDate) : NaN;
  const date = Number.isFinite(internalDate)
    ? new Date(internalDate).toISOString()
    : (() => {
        const d = new Date(header(headers, "Date") ?? "");
        return Number.isNaN(d.getTime()) ? "" : d.toISOString();
      })();

  return {
    from: parseAddress(header(headers, "From")),
    replyTo: replyToRaw ? parseAddress(replyToRaw) : null,
    to: splitAddressList(header(headers, "To")),
    cc: splitAddressList(header(headers, "Cc")),
    subject: (header(headers, "Subject") ?? "").trim(),
    date,
    headers: automation,
    bodyText: cleanBody(body),
    snippet: (message.snippet ?? "").trim(),
  };
}
