# DealFlow email agent

Reads forwarded deal emails from one shared inbox and populates the DealFlow
Supabase pipeline. Anyone with a DealFlow account forwards (or sets a filter to
auto-forward) deal emails to the shared address; the agent reads them, extracts
the deal with Claude, and inserts/updates rows in the `deals` table.

```
shared Gmail inbox  →  Claude (claude-opus-4-8)  →  Supabase `deals`
```

## One-time setup (~15 min)

### 1. Add the new columns to Supabase
Supabase → **SQL Editor** → **New query** → paste all of `../schema_email_agent.sql`
→ **Run**. This is additive — it does not drop the table or touch existing rows.

### 2. Create the shared inbox + an app password
- Use/create a Google account for the shared address (e.g. `deals@yourfirm.com`).
- Turn on **2-Step Verification** for it.
- Create an **App Password**: https://myaccount.google.com/apppasswords (16 chars).
- Tell your team to forward deal emails there. (Optional: a Gmail filter that
  labels them `DealFlow` — then set `GMAIL_MAILBOX=DealFlow`.)

### 3. Fill in credentials
```
cd "agent"
cp .env.example .env
```
Edit `.env`:
- `ANTHROPIC_API_KEY` — https://console.anthropic.com
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — Supabase → Project Settings → API
  (use the **service_role** secret, not the anon key — the agent isn't a logged-in
  user, so it needs to bypass row-level security to write).
- `GMAIL_USER` + `GMAIL_APP_PASSWORD` from step 2.

### 4. Install + run
```
npm install
npm run ingest:dry   # safe: extracts and prints, writes nothing, marks nothing
npm run ingest       # live: writes to Supabase, marks emails as read
```

New deals appear on your live DealFlow site immediately (it's realtime).

## How it behaves

- **Idempotent** — each email's Message-ID is stored on the row it creates;
  re-running never double-inserts. Processed mail is marked **read** (`\Seen`);
  only unread mail from the last `LOOKBACK_DAYS` (default 30) is considered.
- **Not a deal?** Newsletters/marketing are detected and skipped (marked read).
- **Duplicate handling** ("update if confident, else flag"):
  - same address or nickname → **updates** the existing deal (fills fields the
    email confidently provides, appends a dated note, merges contacts/dates/docs;
    stage only advances, never silently reverts).
  - a loose/ambiguous address overlap → **inserts a new row flagged**
    `[NEEDS REVIEW: possible duplicate of …]` and sets `needs_review = true`.
  - low extraction confidence → inserted but flagged `[LOW CONFIDENCE]`.
- An email that errors is **left unread** so the next run retries it.

## Running it on a schedule (optional)
Once it works by hand, add a local cron entry (macOS):
```
*/15 * * * * cd "/Users/samszapiro/Desktop/dealflow 3/agent" && /usr/bin/env node ingest.mjs >> ingest.log 2>&1
```

## Files
- `extract.mjs` — Claude call + the forced-tool schema (the deal shape).
- `ingest.mjs` — inbox read, dedupe, duplicate-matching, and Supabase writes.
