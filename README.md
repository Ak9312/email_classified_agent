# Job-Inbox Email Classifier

Automatically labels every new email in your **job-application Gmail account** with one of four labels:

| Label | What goes there |
|---|---|
| **Interview / Recruiter** | A real person (recruiter, HR, hiring manager) writing to you about a role, an interview or next steps |
| **Job Alerts** | Automated job listings from Naukri, LinkedIn, Foundit, Indeed, etc. |
| **Rejections** | Any email saying you weren't selected or the role is closed |
| **Other** | Everything else |

It **only adds labels**. It never deletes, archives, marks as read, or sends anything. A test fails the build if code that could do any of that is ever added.

```
New email → Gmail → Google Pub/Sub → your Vercel function → sender rules or a free AI model (OpenRouter) → label added
Every morning: Vercel Cron renews the Gmail "watch" and re-checks the last 7 days for anything missed
```

The full technical design is in [SPEC.md](SPEC.md).

---

## Before you start

You need:

- The **job-application Gmail account**, with the four labels already created using exactly these names: `Interview / Recruiter`, `Job Alerts`, `Rejections`, `Other`.
- A **Google account** for Google Cloud. It can be the same job account or your main account. Everything used here is free.
- A **GitHub** account (this repo) and a free **Vercel** account (sign up at vercel.com with GitHub).
- A free **OpenRouter** account (openrouter.ai).
- A computer with **Node.js 22** (LTS) installed, used for three one-time commands. Download it from nodejs.org and install with the default options.

Set aside about **1 hour**. Each step below says where to click and what to copy. Keep a text file open as your **notes file** to paste values into as you go. Some of those values are secrets: never share that file or commit it.

> **Tip:** Google and Vercel sometimes rename menus. If a button isn't exactly where described, use the search bar at the top of the page.

---

## Step 0: Get the code onto your computer

1. Open a terminal: **Terminal** on Mac, **PowerShell** on Windows.
2. Run these one at a time:

```bash
git clone https://github.com/Ak9312/email_classified_agent.git
```

```bash
cd email_classified_agent
```

```bash
npm install
```

```bash
npm test
```

The last command should end with a line like `Tests 114 passed`.

3. Make your private settings file by copying the example:
   - Mac: `cp .env.example .env.local`
   - Windows: `copy .env.example .env.local`

   Open `.env.local` in any text editor. You'll fill it in during the next steps. It is **never** uploaded to GitHub.

---

## Step 1: Create a Google Cloud project and turn on two APIs

1. Go to **console.cloud.google.com** and sign in.
2. Click the project picker at the top left, then **New project**. Name it `job-inbox-classifier`, then click **Create**. Make sure the new project is selected in the picker.
3. In the search bar, type **Gmail API**, open it, then click **Enable**.
4. Search for **Cloud Pub/Sub API**, open it, then click **Enable**.
5. Open the ☰ menu → **Cloud overview** → **Dashboard**. Copy the **Project ID** (for example `job-inbox-classifier-123456`) into your notes file.

## Step 2: Set up Google sign-in (OAuth)

This lets the app read your job inbox and add labels to it.

1. Search for **Google Auth Platform** (older name: **OAuth consent screen**) and open it. Click **Get started** if asked.
2. **App information:** app name `Job Inbox Classifier`, support email = your email. **Audience:** **External**. **Contact info:** your email. Agree and click **Create**.
3. Go to **Audience**:
   - Under **Test users**, click **Add users** and add your **job-application Gmail address**.
   - Under **Publishing status**, click **Publish app** and confirm, so it says **In production**.

   ⚠️ **This step matters.** If the app stays in "Testing", Google expires your sign-in after 7 days and labeling silently stops.
4. Go to **Data access** → **Add or remove scopes**. In the filter, type `gmail.modify`, tick `https://www.googleapis.com/auth/gmail.modify`, then click **Update** and **Save**.
5. Go to **Clients** → **Create client**. Application type: **Desktop app**. Name: `classifier-local`. Click **Create**.
6. Copy the **Client ID** and **Client secret** into `.env.local`:

```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
```

## Step 3: Get your refresh token (one time)

1. In the terminal, inside the project folder, run:

```bash
npm run get-refresh-token
```

2. It prints a long link. Open it in your browser and **sign in with the job-application Gmail account**, not your main one.
3. Google warns **"Google hasn't verified this app"**. That's expected: it's your own app. Click **Advanced** → **Go to Job Inbox Classifier (unsafe)**.
4. Tick the Gmail permission if there's a checkbox, then click **Continue**.
5. The browser says "Done!" and the terminal prints your **refresh token**. Copy it into `.env.local`:

```
GOOGLE_REFRESH_TOKEN=1//0g...
GMAIL_ADDRESS=your.job.address@gmail.com
```

> If it says "did not return a refresh token": go to myaccount.google.com/permissions (signed in as the job account), remove "Job Inbox Classifier", and run the command again.

## Step 4: Create the Pub/Sub topic and let Gmail publish to it

1. In Google Cloud, search for **Pub/Sub** and open **Topics**.
2. Click **Create topic**. Topic ID: `gmail-job-inbox`. **Untick** "Add a default subscription". Click **Create**.
3. On the topic page, open the **Permissions** tab (you may need to click **Show info panel** first) and click **Add principal**:
   - New principal: `gmail-api-push@system.gserviceaccount.com`
   - Role: **Pub/Sub Publisher**
   - Click **Save**.

   Without this, Gmail can't notify you and Step 8 fails with "permission denied".
4. Put the full topic name in `.env.local`, using your Project ID from Step 1:

```
PUBSUB_TOPIC=projects/YOUR-PROJECT-ID/topics/gmail-job-inbox
```

## Step 5: OpenRouter (the free AI model)

1. Sign in at **openrouter.ai**. Go to **Keys** → **Create key**, name it `job-inbox`, and copy the key (`sk-or-...`).
2. Go to **Settings** → **Privacy** (or "Data policy"). Free models only work if you **allow providers that may log or train on prompts**. Turn that on.
   - What this means: the sender, subject and first 3,000 characters of each email (except ones caught by the sender rules) are sent to a free AI provider.
3. Choose **two free models**. Go to **openrouter.ai/models**, filter by **Prices → Free**, and pick two general chat models from well-known providers. Their IDs end in `:free`. Free models come and go, so check they're still listed.
4. Fill in `.env.local`:

```
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODELS=first-model-id:free,second-model-id:free
```

The first model is used normally. The second is the backup if the first is busy or down.

## Step 6: Make two secret passwords

These protect your two web addresses from strangers.

1. Generate a random value. This works on both Mac and Windows:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

2. Run it **twice**, and put the two different values in `.env.local`:

```
WEBHOOK_SECRET=first-random-value
CRON_SECRET=second-random-value
```

Leave `DRY_RUN=true` for now. In dry-run mode it only *logs* what it would do and never touches your labels.

## Step 7: Deploy to Vercel

1. Make sure `main` is the default branch on GitHub: repo → **Settings** → **General** → **Default branch**.
2. Go to **vercel.com** → **Add New…** → **Project** → find `email_classified_agent` → **Import**.
3. **Framework preset:** "Other". Leave the build settings empty.
4. Open **Environment Variables** and add **every line from your `.env.local`** except `FIXTURE_DENYLIST`, with the same names and values. You can paste the whole file into the first box and Vercel splits it into variables.
5. Click **Deploy** and wait for "Congratulations".
6. Copy your production address from the project page, for example `https://email-classified-agent.vercel.app`.
7. Check that **Fluid compute** is on: Project → **Settings** → **Functions** → **Fluid Compute** should be enabled. It's the default for new projects. If you changed it, click **Redeploy** on the latest deployment.

> Changed a variable later? Vercel only picks it up after a redeploy: **Deployments** → ⋯ on the latest → **Redeploy**.

## Step 8: Create the push subscription (Gmail → your Vercel app)

1. Google Cloud → **Pub/Sub** → **Subscriptions** → **Create subscription**.
2. Fill in:
   - **Subscription ID:** `gmail-job-inbox-push`
   - **Topic:** `gmail-job-inbox`
   - **Delivery type:** **Push**
   - **Endpoint URL:** your Vercel address + `/api/gmail-push?key=` + your `WEBHOOK_SECRET`, for example `https://email-classified-agent.vercel.app/api/gmail-push?key=3f9a…`
   - **Enable authentication:** **leave unticked**
   - **Acknowledgement deadline:** `600` seconds
   - **Message retention duration:** 1 day
   - **Expiration period:** **Never expire**
   - **Retry policy:** **Retry after exponential backoff delay**
3. Click **Create**.

## Step 9: Start the Gmail watch

In the terminal (it uses your `.env.local`), run:

```bash
npm run start-watch
```

You should see `Found all four labels…`, then `Watch active…` with an expiry date about a week away. The daily cron renews it automatically from now on.

> **If it says a label was not found:** Gmail treats `/` as "label inside a label", so `Interview / Recruiter` may have been saved under a slightly different name. The error message lists the label names Gmail actually has. Either rename the label in Gmail to exactly `Interview / Recruiter`, or open `lib/config.ts`, change the right-hand side of the line `"Interview / Recruiter": "Interview / Recruiter",` to the exact name shown, and push the change to GitHub. Vercel redeploys automatically.
>
> **If it says permission denied:** redo Step 4.3.

## Step 10: Check that it works

1. From your **main** email account, send an email to the job address, for example "Hi, I'm a recruiter at Example Corp, are you free for a call tomorrow about the Data Analyst role?"
2. In Vercel, open your project → **Logs**. Within a minute you should see a line containing `"evt":"classified"` with `"label":"Interview / Recruiter"` and `"dryRun":true`.
3. No label appears in Gmail yet, because dry-run is on.

Nothing in the logs? Check that the subscription URL from Step 8 is exactly right. A line with `"evt":"auth_failed"` means the `?key=` part doesn't match `WEBHOOK_SECRET`.

---

## Rollout

### Day 1: dry run with test emails
1. From your main account, send **8–10 test emails** to the job address covering all four labels. Copy text from the files in `test/fixtures/emails/`, and include at least two of the tricky ones (a polite rejection, an assessment invite).
   - Test "job alerts" sent from your personal address won't match the sender rules, so the AI model decides those. That's expected.
2. Sign up for **job alerts** on LinkedIn, Naukri, Foundit and Indeed using the job address, so real alerts start arriving.
3. Run the daily job once by hand: Vercel → project → **Settings** → **Cron Jobs** → **Run** next to `/api/cron/renew-watch`.
4. In **Logs**, check that every test email has a `classified` line with the right label, there are no `auth_failed` lines, and no labels actually appear in Gmail.

### Day 2: go live
1. If anything was wrong, adjust the rules (`lib/rules.config.ts`) or the AI instructions (`lib/prompt.ts`), then push to GitHub.
2. In Vercel → **Settings** → **Environment Variables**, change `DRY_RUN` to `false`, then **Redeploy**.
3. Send 2–3 more test emails and check in Gmail that the right label appears **and the email is still unread and still in the inbox**.

### First week
- Look in **Other** once a day for any recruiter email that was missed.
- When real job alerts arrive, note the sender address. If a platform uses an address not in `lib/rules.config.ts`, add it.

---

## Measuring accuracy (eval set)

`test/fixtures/emails/` holds example emails with the correct label. There are 10 made-up tricky cases now. Add about 25 real job emails copied from your **main** inbox.

**The GitHub repo is public. Anything you commit can be seen by anyone.**

### Adding a real email
1. Copy one of the existing files, e.g. `rej-001.json`, and name it after its label: `int-005.json`, `alert-002.json`, `rej-004.json`, `oth-003.json` and so on. The file name must match the `"id"` inside.
2. Set `"source": "main-inbox"`, `"expected"` to the correct label, and `"notes"` to why the case is interesting.
3. Paste in the sender, subject and body, **anonymizing as you go**:
   - [ ] Your name, email, phone, address, date of birth and profile links → `Candidate`, `candidate@example.com`, `+91-90000-00000`
   - [ ] Recruiter or HR names, emails and phones → made-up ones (`Riya Sharma`, `riya.sharma@example-corp.com`)
   - [ ] **Keep platform sender addresses exact** (e.g. `jobalerts-noreply@linkedin.com`), because the rules depend on them
   - [ ] Employer names → `Example Corp` / `example-corp.com`, unless the name matters
   - [ ] Every link with a long code in it (apply, unsubscribe, tracking) → `https://example.com/...`
   - [ ] Remove application or reference IDs, OTPs and salary figures
   - [ ] Remove signatures with phone numbers, and older quoted messages
   - [ ] No attachments
4. In `.env.local`, set `FIXTURE_DENYLIST` to your real details, comma-separated, e.g. `Firstname Lastname,me@gmail.com,9876543210,Pune`. This stays on your computer.
5. Run `npm run check-fixtures`. It refuses anything containing your denylisted details, real-looking email addresses, phone numbers, or links with tokens. Fix whatever it reports.
6. Run `npm test`.

### Running the eval

```bash
npm run eval
```

It sends each fixture to the AI model (paced to stay within free limits) and prints the accuracy and a table of mistakes. The target is **90% or better**, with **no rejection or recruiter email labeled as a Job Alert**. To compare models, run `npm run eval -- --model some-model-id:free` for each one, at most a couple of models per day because of the free daily limit. Put the best two in `OPENROUTER_MODELS`.

---

## Everyday questions

**An email wasn't labeled.** The AI may have been busy. The function retries on the next email and every morning, covering the last 7 days. Search Vercel **Logs** for `classify_failed` to see why.

**An email got the wrong label.** Fix it by hand in Gmail: remove the wrong label and add the right one. The app never touches an email that already has one of the four labels. If the same mistake keeps happening, add a similar example to the fixtures and adjust `lib/prompt.ts` or `lib/rules.config.ts`.

**Everything stopped.** Check Vercel **Logs**:
- `config_error`: a missing or misspelled environment variable.
- `invalid_grant`: the refresh token expired. Redo Step 3, update `GOOGLE_REFRESH_TOKEN` in Vercel, and redeploy. Make sure Step 2.3 says **In production**.
- `watch_failed`: re-run `npm run start-watch`.

**"quota_exhausted" in the logs.** You used up OpenRouter's free daily requests. It resets daily, and unlabeled emails are retried the next morning. Adding a small credit balance to OpenRouter raises the free limits.

**Changing a secret.** Set the new `WEBHOOK_SECRET` in Vercel, redeploy, then edit the push subscription's endpoint URL in Google Cloud.

---

## For developers

| Command | What it does |
|---|---|
| `npm test` | Fixture check + all unit tests (safety, rules, extract, LLM parsing, webhook auth, loop, endpoints) |
| `npm run typecheck` | TypeScript check |
| `npm run check-fixtures` | Validate fixtures and scan them for personal data |
| `npm run eval [-- --model id]` | Classifier accuracy on the fixtures (uses OpenRouter quota) |
| `npm run get-refresh-token` | One-time Google sign-in |
| `npm run start-watch` | Start or renew the Gmail watch |

Layout: `api/` holds the two Vercel functions, `lib/` the logic (`gmail.ts` is the only Gmail API module), `scripts/` the local tools and `test/` the vitest suites and fixtures. `test/fixtures/mime/` contains synthetic Gmail API messages (`format=full` JSON) for the extraction tests.
