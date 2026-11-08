import { describe, expect, it } from "vitest";
import { matchRule } from "../lib/rules";
import { RULES } from "../lib/rules.config";
import { loadFixtures } from "../scripts/check-fixtures";

const mail = (address: string, subject: string) => ({ from: { name: "", address }, subject });

/** Every rule must have at least one positive case here (spec §7.3: "every rule has a fixture test"). */
const POSITIVE: Record<string, ReturnType<typeof mail>[]> = {
  "linkedin-job-alerts": [mail("jobalerts-noreply@linkedin.com", "Data Analyst: Example Corp and 9 more"), mail("jobs-listings@linkedin.com", "Jobs similar to Data Analyst")],
  "linkedin-jobs-noreply": [mail("jobs-noreply@linkedin.com", "New jobs for you in Bengaluru")],
  "naukri-alerts": [mail("jobalerts@naukrialerts.com", "25 new jobs matching your profile"), mail("info@naukri.com", "Recommended jobs for you")],
  "foundit-alerts": [mail("alerts@foundit.in", "Jobs for you: Data Analyst")],
  "indeed-alerts": [mail("alert@indeed.com", "20 new Data Analyst jobs in Pune")],
  "glassdoor-alerts": [mail("noreply@glassdoor.com", "Data Analyst jobs you may like")],
  "instahyre-alerts": [mail("jobs@instahyre.com", "New job openings matching your profile")],
  "cutshort-alerts": [mail("hello@cutshort.io", "Example Corp is hiring a Data Engineer")],
  "hirist-alerts": [mail("alerts@hirist.tech", "Recommended jobs for you this week")],
  "wellfound-alerts": [mail("talent@wellfound.com", "New jobs matching your preferences")],
};

describe("rules", () => {
  it("every rule has a positive test case", () => {
    for (const r of RULES) expect(POSITIVE[r.id], `missing test for rule ${r.id}`).toBeDefined();
  });

  for (const [ruleId, cases] of Object.entries(POSITIVE)) {
    it(`${ruleId} matches its alerts`, () => {
      for (const c of cases) expect(matchRule(c)).toEqual({ label: "Job Alerts", ruleId });
    });
  }

  it("rules only ever output Job Alerts", () => {
    for (const r of RULES) expect(r.label).toBe("Job Alerts");
  });

  it("recruiter-message senders never match", () => {
    expect(matchRule(mail("messages-noreply@linkedin.com", "New jobs for you"))).toBeNull();
    expect(matchRule(mail("inmail-hit-reply@linkedin.com", "Jobs for you"))).toBeNull();
    expect(matchRule(mail("info@naukri.com", "Recruiter from Example Corp sent you a message"))).toBeNull();
    expect(matchRule(mail("x@indeedemail.com", "New jobs for you"))).toBeNull();
  });

  it("guard: application updates/rejections from platform senders go to the LLM", () => {
    expect(matchRule(mail("jobs-noreply@linkedin.com", "Your application to Data Analyst at Example Corp"))).toBeNull();
    expect(matchRule(mail("jobs-noreply@linkedin.com", "Your update from Example Corp"))).toBeNull();
    expect(matchRule(mail("jobalerts-noreply@linkedin.com", "Unfortunately, new jobs for you"))).toBeNull();
    expect(matchRule(mail("alert@indeed.com", "Interview request: 3 new jobs"))).toBeNull();
    expect(matchRule(mail("info@naukri.com", "Application status update: new jobs"))).toBeNull();
  });

  it("platform sender without alert wording is left to the LLM", () => {
    expect(matchRule(mail("info@naukri.com", "Complete your profile to get noticed"))).toBeNull();
    expect(matchRule(mail("alert@indeed.com", "Verify your email address"))).toBeNull();
  });

  it("lookalike domains do not match", () => {
    expect(matchRule(mail("jobs@notnaukri.com", "New jobs for you"))).toBeNull();
    expect(matchRule(mail("jobs@naukri.com.evil.example", "New jobs for you"))).toBeNull();
  });

  it("subdomains of a rule domain match", () => {
    expect(matchRule(mail("x@mail.naukri.com", "New jobs for you"))?.ruleId).toBe("naukri-alerts");
  });

  describe("against the eval fixtures", () => {
    const { fixtures } = loadFixtures();
    it("fixtures loaded", () => expect(fixtures.length).toBeGreaterThan(0));
    for (const f of fixtures) {
      it(`${f.id}: a rule fires only for Job Alerts`, () => {
        const m = matchRule(f.email);
        if (m) expect(f.expected).toBe("Job Alerts");
      });
    }
    it("alert-001 (Naukri alert) is caught by a rule", () => {
      expect(matchRule(fixtures.find((f) => f.id === "alert-001")!.email)?.ruleId).toBe("naukri-alerts");
    });
  });
});
