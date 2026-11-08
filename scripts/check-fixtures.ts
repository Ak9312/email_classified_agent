/**
 * Validates every eval fixture (spec §11.2) and scans it for personal data (spec §11.3).
 * Runs as part of `npm test`. Exit code 1 on any problem.
 *
 *   npm run check-fixtures
 *
 * Reads FIXTURE_DENYLIST (comma-separated real personal details) from .env.local if present.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { CATEGORIES, type Category } from "../lib/config";
import { EmailFeaturesSchema } from "../lib/extract";
import { RULES } from "../lib/rules.config";

export const FIXTURES_DIR = resolve(__dirname, "..", "test", "fixtures", "emails");

export const ID_PREFIX: Record<Category, string> = {
  "Interview / Recruiter": "int-",
  "Job Alerts": "alert-",
  Rejections: "rej-",
  Other: "oth-",
};

export const FixtureSchema = z
  .object({
    id: z.string().regex(/^(int|alert|rej|oth)-\d{3}$/, 'must look like "rej-001"'),
    expected: z.enum(CATEGORIES),
    source: z.enum(["main-inbox", "handwritten"]),
    notes: z.string().min(1),
    email: EmailFeaturesSchema,
  })
  .strict();

export type Fixture = z.infer<typeof FixtureSchema>;

/** Domains allowed to appear in email addresses inside fixtures. */
const PLACEHOLDER_DOMAINS = ["example.com", "example.org", "example.net", "example-corp.com", "example.in"];
const ATS_AND_PLATFORM_DOMAINS = [
  "linkedin.com",
  "greenhouse.io",
  "lever.co",
  "myworkdayjobs.com",
  "workday.com",
  "smartrecruiters.com",
  "ashbyhq.com",
  "icims.com",
  "successfactors.com",
  "taleo.net",
  "zohorecruit.com",
  "darwinbox.in",
  "keka.com",
  "calendly.com",
  "hackerrank.com",
  "hackerearth.com",
  "codility.com",
  "mettl.com",
  "google.com",
];
export const ALLOWED_DOMAINS = [
  ...PLACEHOLDER_DOMAINS,
  ...ATS_AND_PLATFORM_DOMAINS,
  ...RULES.flatMap((r) => [...(r.fromDomain ?? []), ...(r.fromAddress ?? []).map((a) => a.split("@")[1])]),
];

function domainAllowed(domain: string): boolean {
  const d = domain.toLowerCase();
  if (d === "gmail.com") return false; // a gmail address in a fixture is almost certainly a real person
  return ALLOWED_DOMAINS.some((a) => d === a || d.endsWith(`.${a}`)) || /(^|\.)example(-[a-z]+)?\.[a-z.]+$/.test(d);
}

/** All human-readable text of a fixture that could carry personal data (not ids or dates). */
function textFields(f: Fixture): string[] {
  const e = f.email;
  return [
    e.from.name,
    e.from.address,
    e.replyTo?.name ?? "",
    e.replyTo?.address ?? "",
    ...e.to,
    ...e.cc,
    e.subject,
    ...Object.values(e.headers).filter((v): v is string => typeof v === "string"),
    e.bodyText,
    e.snippet,
    f.notes,
  ];
}

/** Returns human-readable problems found in a fixture's text. Exported for tests. */
export function scanForPersonalData(f: Fixture, denylist: string[]): string[] {
  const problems: string[] = [];
  const text = textFields(f).join("\n");
  const lower = text.toLowerCase();

  for (const term of denylist) {
    if (term && lower.includes(term.toLowerCase())) problems.push(`contains a FIXTURE_DENYLIST term (#${denylist.indexOf(term) + 1})`);
  }

  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
    if (!domainAllowed(m[1])) problems.push(`email address with a non-placeholder domain: ${m[0]}`);
  }

  const phoneLike = /(?:\+\d{1,3}[\s-]?)?\(?\d{2,5}\)?[\s-]?\d{3,5}[\s-]?\d{3,5}/g;
  const withoutUrls = text.replace(/https?:\/\/\S+/g, " "); // URLs are checked separately below
  for (const m of withoutUrls.matchAll(phoneLike)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 13) continue;
    if (/0{5,}/.test(digits)) continue; // placeholder such as +91-90000-00000
    problems.push(`looks like a phone number: ${m[0].trim()}`);
  }

  for (const m of text.matchAll(/https?:\/\/([^\s/<>"')]+)([^\s<>"')]*)/g)) {
    const host = m[1].toLowerCase();
    const rest = m[2];
    if (/(^|\.)example(-[a-z]+)?\.[a-z.]+$/.test(host)) continue;
    if (/[A-Za-z0-9_-]{16,}/.test(rest)) problems.push(`URL with a token-like string (replace with https://example.com/...): ${m[0].slice(0, 80)}`);
  }

  return [...new Set(problems)];
}

export function loadFixtures(dir = FIXTURES_DIR): { fixtures: Fixture[]; problems: string[] } {
  const fixtures: Fixture[] = [];
  const problems: string[] = [];
  if (!existsSync(dir)) return { fixtures, problems: [`fixtures folder not found: ${dir}`] };
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const seen = new Map<string, string>();
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch (err) {
      problems.push(`${file}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const parsed = FixtureSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) problems.push(`${file}: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
      continue;
    }
    const f = parsed.data;
    if (seen.has(f.id)) problems.push(`${file}: duplicate id "${f.id}" (also in ${seen.get(f.id)})`);
    seen.set(f.id, file);
    if (!f.id.startsWith(ID_PREFIX[f.expected])) problems.push(`${file}: id "${f.id}" should start with "${ID_PREFIX[f.expected]}" for "${f.expected}"`);
    if (file !== `${f.id}.json`) problems.push(`${file}: file name should be "${f.id}.json"`);
    fixtures.push(f);
  }
  if (files.length === 0) problems.push(`no fixtures in ${dir}`);
  return { fixtures, problems };
}

function loadLocalEnv(): void {
  const p = resolve(__dirname, "..", ".env.local");
  if (existsSync(p)) process.loadEnvFile(p);
}

function main(): void {
  loadLocalEnv();
  const denylist = (process.env.FIXTURE_DENYLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);

  const { fixtures, problems } = loadFixtures();
  for (const f of fixtures) for (const p of scanForPersonalData(f, denylist)) problems.push(`${f.id}.json: ${p}`);

  const counts = CATEGORIES.map((c) => `${c}: ${fixtures.filter((f) => f.expected === c).length}`).join(", ");
  if (problems.length) {
    console.error(`check-fixtures: ${problems.length} problem(s) in ${fixtures.length} fixture(s):`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log(`check-fixtures: ${fixtures.length} fixtures OK (${counts}).` + (denylist.length ? ` Denylist: ${denylist.length} terms.` : " (No FIXTURE_DENYLIST set.)"));
}

if (require.main === module) main();
