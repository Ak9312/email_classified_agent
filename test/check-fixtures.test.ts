/** The personal-data scanner and fixture schema (spec §11.2–11.3). */
import { describe, expect, it } from "vitest";
import { FixtureSchema, loadFixtures, scanForPersonalData, type Fixture } from "../scripts/check-fixtures";

const base: Fixture = {
  id: "oth-999",
  expected: "Other",
  source: "handwritten",
  notes: "test",
  email: {
    from: { name: "Example", address: "no-reply@example-corp.com" },
    replyTo: null,
    to: ["candidate@example.com"],
    cc: [],
    subject: "Hello",
    date: "2026-10-01T00:00:00Z",
    headers: {},
    bodyText: "Call +91-90000-00000 or visit https://example.com/abcdefghijklmnopqrstuvwxyz",
    snippet: "",
  },
};
const withBody = (bodyText: string): Fixture => ({ ...base, email: { ...base.email, bodyText } });

describe("scanForPersonalData", () => {
  it("passes clean placeholder data", () => expect(scanForPersonalData(base, [])).toEqual([]));
  it("flags denylist terms (case-insensitive)", () => {
    expect(scanForPersonalData(withBody("Hi Ananya Real"), ["ananya real"])).toHaveLength(1);
  });
  it("flags real-looking email addresses, including gmail", () => {
    expect(scanForPersonalData(withBody("mail me at someone@gmail.com"), [])[0]).toMatch(/non-placeholder domain/);
    expect(scanForPersonalData(withBody("hr@realcompany.co.in"), [])[0]).toMatch(/non-placeholder domain/);
  });
  it("allows platform sender addresses", () => {
    expect(scanForPersonalData(withBody("from jobalerts-noreply@linkedin.com and x@naukrialerts.com"), [])).toEqual([]);
  });
  it("flags phone numbers but not placeholders or dates", () => {
    expect(scanForPersonalData(withBody("call 98765 43210"), [])[0]).toMatch(/phone/);
    expect(scanForPersonalData(withBody("call +91 9876543210"), [])[0]).toMatch(/phone/);
    expect(scanForPersonalData(withBody("on 2026-10-14 at 10:30"), [])).toEqual([]);
  });
  it("flags token-like URLs outside example domains", () => {
    expect(scanForPersonalData(withBody("https://www.linkedin.com/comm/jobs/view/AbCdEf1234567890XyZ"), [])[0]).toMatch(/token-like/);
    expect(scanForPersonalData(withBody("https://www.linkedin.com/jobs"), [])).toEqual([]);
  });
});

describe("fixture schema", () => {
  it("rejects a bad id, unknown label and extra fields", () => {
    expect(FixtureSchema.safeParse({ ...base, id: "x1" }).success).toBe(false);
    expect(FixtureSchema.safeParse({ ...base, expected: "Spam" }).success).toBe(false);
    expect(FixtureSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
  it("all committed fixtures are valid and clean", () => {
    const { fixtures, problems } = loadFixtures();
    expect(problems).toEqual([]);
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
    for (const f of fixtures) expect(scanForPersonalData(f, []), f.id).toEqual([]);
  });
});
