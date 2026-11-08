/**
 * Deterministic sender rules (data only). Rules may ONLY output "Job Alerts"; anything not matched
 * goes to the LLM (spec §7.3).
 *
 * ⚠ Platforms change their sender addresses. Confirm these against real alert emails (the platform
 * senders kept in your main-inbox fixtures and the first real alerts the new account receives)
 * before going live. To change a rule: edit this file, add a test case in test/rules.test.ts,
 * run `npm test`, redeploy.
 *
 * Deliberately NOT here (they carry recruiter messages, application updates or rejections and must
 * go to the LLM): messages-noreply@linkedin.com, inmail-hit-reply@linkedin.com, Naukri
 * "recruiter sent you a message" mails, and Indeed employer messages relayed via indeedemail.com.
 */

export interface Rule {
  id: string;
  /** Exact sender addresses (lowercase). */
  fromAddress?: string[];
  /** Sender domains; subdomains also match (e.g. "naukri.com" matches "alerts.naukri.com"). */
  fromDomain?: string[];
  /** If set, the subject must ALSO match. */
  subjectRegex?: RegExp;
  label: "Job Alerts";
}

/** Typical job-alert subject wording. */
const ALERT_SUBJECT =
  /\bjobs? (for you|matching|you may|alert)|\brecommended jobs?\b|\bnew\b[^.]*\bjobs?\b|\bjobs? recommendations?\b|\bis hiring\b|\bare hiring\b|\bjob openings?\b/i;

export const RULES: Rule[] = [
  {
    id: "linkedin-job-alerts",
    fromAddress: ["jobalerts-noreply@linkedin.com", "jobs-listings@linkedin.com"],
    label: "Job Alerts",
  },
  {
    // jobs-noreply@linkedin.com also sends application confirmations and employer updates
    // (which can be rejections), so it needs alert-style subject wording.
    id: "linkedin-jobs-noreply",
    fromAddress: ["jobs-noreply@linkedin.com"],
    subjectRegex: ALERT_SUBJECT,
    label: "Job Alerts",
  },
  { id: "naukri-alerts", fromDomain: ["naukri.com", "naukrialerts.com"], subjectRegex: ALERT_SUBJECT, label: "Job Alerts" },
  { id: "foundit-alerts", fromDomain: ["foundit.in"], subjectRegex: ALERT_SUBJECT, label: "Job Alerts" },
  { id: "indeed-alerts", fromDomain: ["indeed.com"], subjectRegex: ALERT_SUBJECT, label: "Job Alerts" },
  { id: "glassdoor-alerts", fromDomain: ["glassdoor.com", "glassdoor.co.in"], subjectRegex: ALERT_SUBJECT, label: "Job Alerts" },
  { id: "instahyre-alerts", fromDomain: ["instahyre.com"], subjectRegex: ALERT_SUBJECT, label: "Job Alerts" },
  { id: "cutshort-alerts", fromDomain: ["cutshort.io"], subjectRegex: ALERT_SUBJECT, label: "Job Alerts" },
  { id: "hirist-alerts", fromDomain: ["hirist.tech", "hirist.com"], subjectRegex: ALERT_SUBJECT, label: "Job Alerts" },
  { id: "wellfound-alerts", fromDomain: ["wellfound.com"], subjectRegex: ALERT_SUBJECT, label: "Job Alerts" },
];

/**
 * Safety guard: if the subject looks like it could be about MY application (an update, interview
 * or rejection), rules never fire and the LLM decides. Keeps rules conservative (spec §7.2: a
 * rejection or recruiter mail must never become a Job Alert).
 */
export const RULE_GUARD_SUBJECT =
  /\byour application\b|\bapplication (status|update|for|to|received|was)\b|\binterview|\bunfortunately\b|\bregret\b|\bnot (been )?(selected|shortlisted|moving)\b|\bupdate (on|from|regarding)\b|\bcandidacy\b|\bnext steps?\b|\bsent you a message\b|\bmessaged you\b|\bshortlisted\b|\boffer\b|\bassessment\b/i;
