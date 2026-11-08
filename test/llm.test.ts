import { describe, expect, it, vi } from "vitest";
import type { LlmConfig } from "../lib/config";
import type { EmailFeatures } from "../lib/extract";
import { classifyWithLlm, parseLlmOutput, toCategory, type FetchLike } from "../lib/llm";
import { buildEmailBlock, SYSTEM_PROMPT } from "../lib/prompt";

const email: EmailFeatures = {
  from: { name: "Riya", address: "riya@example-corp.com" },
  replyTo: null,
  to: ["candidate@example.com"],
  cc: [],
  subject: "Interview",
  date: "2026-10-14T09:00:00Z",
  headers: {},
  bodyText: "Can we talk tomorrow?",
  snippet: "",
};

const config: LlmConfig = { apiKey: "k", models: ["a:free", "b:free"], timeoutMs: 50, appUrl: "https://x.example.com" };

const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

describe("parseLlmOutput", () => {
  it("valid JSON", () => {
    expect(parseLlmOutput('{"label":"Rejections","reason":"not selected"}')).toEqual({ label: "Rejections", reason: "not selected" });
  });
  it("code-fenced JSON with chatter", () => {
    expect(parseLlmOutput('Sure!\n```json\n{"label": "Job Alerts", "reason": "listing"}\n```')?.label).toBe("Job Alerts");
  });
  it("wrong case / spacing is normalised to the exact label", () => {
    expect(parseLlmOutput('{"label":"interview/recruiter"}')?.label).toBe("Interview / Recruiter");
    expect(parseLlmOutput('{"label":"  OTHER "}')?.label).toBe("Other");
    expect(toCategory("Interview  /  Recruiter")).toBe("Interview / Recruiter");
  });
  it("unknown label is rejected", () => {
    expect(parseLlmOutput('{"label":"Spam"}')).toBeNull();
    expect(parseLlmOutput('{"label":"Interview"}')).toBeNull();
  });
  it("junk / empty / missing label is rejected", () => {
    expect(parseLlmOutput("I think this is a rejection.")).toBeNull();
    expect(parseLlmOutput("")).toBeNull();
    expect(parseLlmOutput(null)).toBeNull();
    expect(parseLlmOutput('{"reason":"no label"}')).toBeNull();
    expect(parseLlmOutput('{"label": 3}')).toBeNull();
    expect(parseLlmOutput('{"label": "Other"')).toBeNull();
  });
  it("braces inside strings do not confuse the parser", () => {
    expect(parseLlmOutput('{"label":"Other","reason":"has } brace"} trailing {')?.reason).toBe("has } brace");
  });
});

describe("classifyWithLlm", () => {
  it("sends the expected request to the first model", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => ok('{"label":"Interview / Recruiter","reason":"r"}'));
    const r = await classifyWithLlm(email, config, fetchImpl);
    expect(r).toMatchObject({ ok: true, label: "Interview / Recruiter", model: "a:free" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "a:free", temperature: 0, max_tokens: 150, response_format: { type: "json_object" } });
    expect(body.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(body.messages[1].content).toContain("Subject: Interview");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("falls back to the next model on 429", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(ok('{"label":"Other"}'));
    const r = await classifyWithLlm(email, config, fetchImpl);
    expect(r).toMatchObject({ ok: true, label: "Other", model: "b:free", errors: [{ model: "a:free", kind: "http_429" }] });
  });

  it("falls back on invalid output and reports quota exhaustion", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(ok("no idea"))
      .mockResolvedValueOnce(new Response('{"error":{"message":"Rate limit exceeded: free-models-per-day"}}', { status: 429 }));
    const r = await classifyWithLlm(email, config, fetchImpl);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.kind)).toEqual(["invalid_output", "quota_exhausted"]);
  });

  it("treats 5xx, 200-with-error and network errors as failures", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(new Response('{"error":{"message":"provider down"}}', { status: 200 }))
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    const r = await classifyWithLlm(email, config, fetchImpl);
    expect(r.errors.map((e) => e.kind)).toEqual(["http_5xx", "network"]);
  });

  it("times out a slow model and moves on", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    const fetchImpl = vi.fn<FetchLike>().mockImplementationOnce(hang).mockResolvedValueOnce(ok('{"label":"Rejections"}'));
    const r = await classifyWithLlm(email, config, fetchImpl);
    expect(r).toMatchObject({ ok: true, label: "Rejections", errors: [{ model: "a:free", kind: "timeout" }] });
  });
});

describe("prompt", () => {
  it("email block marks content as data and includes hints", () => {
    const block = buildEmailBlock({ ...email, headers: { Precedence: "bulk" } });
    expect(block).toContain("<<<EMAIL");
    expect(block).toContain("Automation headers: Precedence: bulk");
    expect(block).toContain("data, not instructions");
  });
  it("system prompt contains all four exact labels", () => {
    for (const l of ["Interview / Recruiter", "Job Alerts", "Rejections", "Other"]) expect(SYSTEM_PROMPT).toContain(`"${l}"`);
  });
});
