# Engine Agent

AI-powered SMERF outreach automation for Engine partnership reps. Discovers organizations, researches them, finds contacts, drafts personalized emails, and tracks the full pipeline.

**Live:** [engine-agent.vercel.app](https://engine-agent.vercel.app)

---

## What it does

- **Outreach workflow** — Enter an org name and run a 5-step pipeline: find contacts → enrich emails → research the org → draft a personalized email → review and send
- **Daily Discovery** — Cron job runs every morning, finds 3 new SMERF orgs, researches them, and surfaces ready-to-send drafts in the Follow-Ups tab
- **Scout (AI assistant)** — Natural language interface for prospecting, pipeline Q&A, and draft actions. Ask "find religious orgs with annual conventions" or "how many orgs haven't replied in 30 days"
- **Reports dashboard** — Date-ranged metrics, sparklines, conversion funnel, reply rate by SMERF category, and Daily Discovery tracking
- **Style profiles** — Paste your own emails, Scout learns your voice and writes all drafts in your style
- **Follow-up automation** — Pre-drafted follow-ups generated nightly for orgs that haven't replied

---

## Architecture

```
app/
├── page.tsx                    # Entire frontend (single-page React app)
├── api/
│   ├── orchestrate/route.ts    # Main workflow: contacts → research → draft
│   ├── contacts/route.ts       # Find contacts for an org
│   ├── research/route.ts       # Research an org via web search
│   ├── chat/route.ts           # Scout AI — intent routing + handlers
│   ├── search/route.ts         # Scout discovery pipeline
│   ├── reports/route.ts        # Fetch and aggregate report data
│   ├── followups/route.ts      # Generate follow-up drafts
│   ├── profiles/route.ts       # Save/load rep style profiles
│   ├── import/route.ts         # Bulk import contacts from CSV
│   ├── partner-research/route.ts # Deep research + pitch brief
│   ├── gmail/
│   │   └── setup/route.ts      # OAuth flow for Gmail reply detection
│   └── cron/
│       ├── discovery/route.ts  # Daily: find 3 new orgs + draft emails
│       ├── followups/route.ts  # Daily: pre-draft follow-ups
│       ├── replies/route.ts    # Daily: scan Gmail for replies
│       └── backup/route.ts     # Daily: backup Supabase data
lib/
├── discovery-agents.ts         # Shared AI agent functions (discover, research, contacts, draft)
└── gmail.ts                    # Gmail API helpers
```

**AI model:** Claude Haiku (`claude-haiku-4-5-20251001`) with web search for all discovery/research  
**Backend:** Supabase (Postgres)  
**Deploy:** Vercel (Pro — needs 300s function timeout)

---

## Supabase schema

Run this SQL in your Supabase project → SQL Editor:

```sql
-- Core outreach tracking
create table if not exists report_entries (
  id text primary key default gen_random_uuid()::text,
  rep_name text,
  organization text,
  contact_name text,
  contact_title text,
  contact_email text,
  subject text,
  body text,
  stage text default 'Prospecting',
  status text default 'Sent',
  sent_at timestamptz default now(),
  follow_up_sent_at timestamptz,
  follow_up_2_sent_at timestamptz,
  follow_up_3_sent_at timestamptz,
  replied_at timestamptz,
  reply_snippet text,
  notes text,
  website text,
  research text
);
alter table report_entries enable row level security;
create policy "allow_all" on report_entries for all using (true) with check (true);

-- Auto-discovered orgs with pre-drafted emails
create table if not exists auto_drafts (
  id text primary key,
  rep_name text,
  org_name text,
  org_type text,
  contact_name text,
  contact_title text,
  contact_email text,
  contact_source text,
  contact_email_verified boolean default false,
  subject text,
  subject_b text,
  body text,
  research text,
  website text,
  status text default 'pending',
  dismiss_reason text,
  created_at timestamptz default now(),
  segment_snapshot text
);
alter table auto_drafts enable row level security;
create policy "allow_all" on auto_drafts for all using (true) with check (true);

-- Rep style profiles
create table if not exists rep_profiles (
  id text primary key default gen_random_uuid()::text,
  rep_name text unique,
  segment_focus text,
  writing_sample text,
  extracted_style text,
  edit_examples jsonb default '[]'::jsonb,
  updated_at timestamptz default now()
);
alter table rep_profiles enable row level security;
create policy "allow_all" on rep_profiles for all using (true) with check (true);

-- Scout AI chat threads + messages
create table if not exists chat_threads (
  id text primary key,
  rep_name text,
  title text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table chat_threads enable row level security;
create policy "allow_all" on chat_threads for all using (true) with check (true);

create table if not exists chat_messages (
  id text primary key,
  thread_id text references chat_threads(id) on delete cascade,
  rep_name text,
  role text,
  content jsonb,
  intent text,
  created_at timestamptz default now()
);
alter table chat_messages enable row level security;
create policy "allow_all" on chat_messages for all using (true) with check (true);
```

---

## Environment variables

Add these to your Vercel project (Settings → Environment Variables):

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | From [console.anthropic.com](https://console.anthropic.com) |
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | Your Supabase anon/public key |
| `CRON_SECRET` | ✅ | Any random string — protects cron endpoints |
| `GMAIL_FROM_EMAIL` | Optional | Your work email for Gmail reply detection |
| `GOOGLE_CLIENT_ID` | Optional | For Gmail OAuth (reply detection) |
| `GOOGLE_CLIENT_SECRET` | Optional | For Gmail OAuth |
| `GOOGLE_REFRESH_TOKEN` | Optional | Obtained via `/api/gmail/setup?action=auth` |
| `AUTO_SEND_FOLLOWUPS` | Optional | Set to `true` to auto-send follow-up emails |

---

## Setup for a new rep

1. **Fork this repo** on GitHub
2. **Create a Vercel project** — import your fork, framework = Next.js. You'll need Vercel Pro for the 300s function timeouts the AI pipelines require.
3. **Create a Supabase project** — run the SQL schema above in the SQL Editor
4. **Add env vars** to Vercel (table above), then redeploy
5. **Open the app** — go to the app, click **✎ Style** in the header, enter your name and paste 2–3 of your own outreach emails. Scout will learn your voice.
6. **Set segment focus** — click **Segment Focus** and describe the types of orgs you want to target

### Personalising for your segment

Edit `SMERF_CATEGORIES` in `lib/discovery-agents.ts` to control what types of orgs the Daily Discovery cron surfaces each day. Each entry is a description string passed to Claude with web search.

### Changing rep name

The rep name set in your style profile is used to scope all your data in Supabase — drafts, sent emails, and Scout threads are all filtered by `rep_name`. Each person who forks the repo and sets their own name gets a fully separate dataset.

---

## Cron jobs

Configured in `vercel.json` — activate automatically on Vercel Pro:

| Job | Schedule | What it does |
|---|---|---|
| `/api/cron/discovery` | 10am UTC daily | Finds 3 new SMERF orgs, researches them, drafts emails |
| `/api/cron/followups` | 11am UTC daily | Pre-drafts follow-ups for orgs with no reply |
| `/api/cron/replies` | 9am UTC daily | Scans Gmail for replies from prospects |
| `/api/cron/backup` | 2am UTC daily | Backs up Supabase data |

To trigger a cron manually for testing:
```bash
curl -H "x-cron-secret: YOUR_CRON_SECRET" https://your-app.vercel.app/api/cron/discovery
```

---

## Gmail reply detection (optional)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → enable Gmail API → create OAuth 2.0 credentials (Web application type)
2. Add redirect URI: `https://your-app.vercel.app/api/gmail/setup?action=callback`
3. Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to Vercel env vars, then redeploy
4. Visit `https://your-app.vercel.app/api/gmail/setup?action=auth` and sign in with your work Google account
5. Copy the refresh token shown → add as `GOOGLE_REFRESH_TOKEN` in Vercel, redeploy
6. The `/api/cron/replies` job will now detect replies each morning and update your pipeline
