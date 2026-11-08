/**
 * Runs the full classifier (rules, then LLM) over the eval fixtures and prints accuracy, a confusion
 * matrix and the misclassified ids (spec §11.2). Needs OPENROUTER_API_KEY and OPENROUTER_MODELS in
 * .env.local. Uses free-tier quota: about one request per fixture not matched by a rule.
 *
 *   npm run eval                          # uses OPENROUTER_MODELS (primary + fallbacks)
 *   npm run eval -- --model some/model:free   # test one model only
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CATEGORIES, getLlmConfig, type Category } from "../lib/config";
import { classify } from "../lib/classify";
import { loadFixtures } from "./check-fixtures";

const PACE_MS = 3_500; // ≈17 requests/min, under the free-tier limit of ~20/min

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const SHORT: Record<Category, string> = { Rejections: "Rej", "Interview / Recruiter": "Int", "Job Alerts": "Alert", Other: "Other" };

async function main(): Promise<void> {
  const envPath = resolve(__dirname, "..", ".env.local");
  if (existsSync(envPath)) process.loadEnvFile(envPath);

  const llm = getLlmConfig();
  const only = arg("model");
  if (only) llm.models = [only];

  const { fixtures, problems } = loadFixtures();
  if (problems.length) {
    console.error("Fix fixture problems first (npm run check-fixtures):\n  " + problems.join("\n  "));
    process.exit(1);
  }

  console.log(`Evaluating ${fixtures.length} fixtures with models: ${llm.models.join(", ")}\n`);
  const confusion = new Map<string, number>(); // "expected|predicted" → count
  const wrong: string[] = [];
  const critical: string[] = [];
  let correct = 0;
  let failed = 0;
  let lastLlmCall = 0;

  for (const f of fixtures) {
    const wait = lastLlmCall + PACE_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const r = await classify(f.email, llm);
    if (!r.ok || r.source === "llm") lastLlmCall = Date.now();

    const predicted = r.ok ? r.label : "FAILED";
    const how = r.ok ? (r.source === "rule" ? `rule:${r.ruleId}` : `llm:${r.model}`) : r.errors.map((e) => `${e.model}:${e.kind}`).join(",");
    const mark = predicted === f.expected ? "✓" : "✗";
    console.log(`${mark} ${f.id.padEnd(10)} expected ${SHORT[f.expected].padEnd(5)} got ${(r.ok ? SHORT[r.label] : "FAILED").padEnd(6)} ${how}`);

    if (!r.ok) {
      failed++;
      wrong.push(`${f.id} (failed: ${how})`);
      continue;
    }
    confusion.set(`${f.expected}|${r.label}`, (confusion.get(`${f.expected}|${r.label}`) ?? 0) + 1);
    if (r.label === f.expected) correct++;
    else {
      wrong.push(`${f.id}: expected ${f.expected}, got ${r.label} — ${r.reason}`);
      if (r.label === "Job Alerts" && (f.expected === "Rejections" || f.expected === "Interview / Recruiter")) critical.push(f.id);
    }
  }

  const pct = fixtures.length ? Math.round((correct / fixtures.length) * 100) : 0;
  console.log(`\nAccuracy: ${correct}/${fixtures.length} = ${pct}%   (failed calls: ${failed})`);

  console.log("\nConfusion matrix (rows = expected, columns = predicted):");
  console.log("".padEnd(8) + CATEGORIES.map((c) => SHORT[c].padStart(7)).join(""));
  for (const e of CATEGORIES) {
    console.log(SHORT[e].padEnd(8) + CATEGORIES.map((p) => String(confusion.get(`${e}|${p}`) ?? 0).padStart(7)).join(""));
  }

  if (wrong.length) console.log("\nMisclassified:\n  " + wrong.join("\n  "));
  console.log(
    `\nTarget: ≥ 90% and 0 rejections/recruiter mails labeled as Job Alerts → ` +
      (pct >= 90 && critical.length === 0 ? "PASS" : `FAIL${critical.length ? ` (critical: ${critical.join(", ")})` : ""}`),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
