/**
 * Follow-up Monitor — Cron Agent
 *
 * Runs daily at 7am ET (11:00 UTC) via Vercel cron.
 * Scans report_entries for due/overdue follow-ups, pre-drafts each email,
 * and stores them in drafted_followups so the rep sees them ready to send
 * when they open the app.
 *
 * Supabase table required (run once in SQL editor):
 *
 * create table if not exists drafted_followups (
 *   id text primary key,
 *   entry_id text,
 *   fu_num integer,
 *   subject text,
 *   body text,
 *   rep_name text,
 *   status text default 'pending',
 *   created_at timestamptz default now()
 * );
 * alter table drafted_followups enable row level security;
 * create policy "allow_all" on drafted_followups for all using (true) with check (true);
 *
 * Set CRON_SECRET in Vercel env vars (any random string) to protect this endpoint.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const maxDuration = 300;

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

function stripDashes(t: string): string {
  return t
    .replace(/ [—–] /g, ", ")
    .replace(/[—–] /g, "")
    .replace(/ [—–]/g, "")
    .replace(/[—–]/g, ", ");
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function callClaude(prompt: string, retries = 3): Promise<string> {
  for (let i = 0; i < retries; i++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 800,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (res.status === 429) { await sleep(4000 * (i + 1)); continue; }
    if (!res.ok) return "";
    const data = await res.json();
    return (data?.content || [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("\n");
  }
  return "";
}

// Draft prompts by follow-up number
function getFuPrompt(fuNum: 1 | 2 | 3, entry: Record<string, unknown>): string {
  const contact = entry.contact_name as string;
  const title = entry.title as string;
  const org = entry.organization as string;
  const subject = entry.subject_line as string;
  const repName = (entry.rep_name as string) || "the rep";

  if (fuNum === 1) return `Write a brief follow-up email #1 from ${repName} at Engine to ${contact}, ${title} at ${org}.

Context: Initial outreach email sent 5 days ago with subject "${subject}". No reply yet. Engine is a hotel booking platform for organizations — member hotel benefit + referral revenue.

Rules:
- 3-4 sentences MAX
- Do NOT say "just following up", "circling back", or "I hope this finds you well"
- Reference something specific about ${org} if possible
- End with ONE soft question ask
- No em dashes
- Casual but professional

Return EXACTLY this format:
SUBJECT: [short subject line]

[email body]`;

  if (fuNum === 2) return `Write follow-up email #2 from ${repName} at Engine to ${contact}, ${title} at ${org}.

Context: Two emails sent over 9 days, no reply. Original subject was "${subject}". Need a fresh angle — don't just repeat the first email.

Rules:
- Add a new angle, data point, or reason they should care NOW
- 3-4 sentences
- Show you know their org specifically
- One direct ask at end
- No em dashes
- Don't mention "second follow-up" explicitly

Return EXACTLY this format:
SUBJECT: Re: [original subject]

[email body]`;

  return `Write a final "closing the loop" email #3 from ${repName} at Engine to ${contact} at ${org}.

Context: Three outreach attempts over 15 days. This is the last email — leave a positive impression.

Rules:
- 2-3 sentences MAX
- Acknowledge you won't keep emailing
- Leave the door open for the future ("if timing changes")
- Warm, not passive-aggressive or guilt-tripping
- No em dashes

Return EXACTLY this format:
SUBJECT: Closing the loop — ${org}

[email body]`;
}

export async function GET(req: NextRequest) {
  // Verify cron authorization
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization");
    // Vercel cron sends: Authorization: Bearer <CRON_SECRET>
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  // Find all entries with follow-ups due by tomorrow
  // Three cases:
  // 1. FU1 not sent and FU1 due <= tomorrow
  // 2. FU1 sent, FU2 not sent, FU2 due <= tomorrow
  // 3. FU2 sent, FU3 not sent, FU3 due <= tomorrow
  const { data: allSentEntries, error } = await db()
    .from("report_entries")
    .select("id,contact_name,title,organization,subject_line,rep_name,follow_up_sent,follow_up_due,follow_up_2_sent,follow_up_2_due,follow_up_3_sent,follow_up_3_due,stage,status")
    .eq("status", "Sent")
    .neq("stage", "Closed Won")
    .neq("stage", "Closed Lost");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!allSentEntries?.length) return NextResponse.json({ drafted: 0, message: "No sent entries found" });

  // Filter to only entries with a due follow-up
  type EntryWithFu = { entry: Record<string, unknown>; fuNum: 1 | 2 | 3 };
  const dueEntries: EntryWithFu[] = [];

  for (const entry of allSentEntries) {
    // Determine which FU is next and if it's due
    if (!entry.follow_up_sent && entry.follow_up_due && entry.follow_up_due <= tomorrowStr) {
      dueEntries.push({ entry, fuNum: 1 });
    } else if (entry.follow_up_sent && !entry.follow_up_2_sent && entry.follow_up_2_due && entry.follow_up_2_due <= tomorrowStr) {
      dueEntries.push({ entry, fuNum: 2 });
    } else if (entry.follow_up_2_sent && !entry.follow_up_3_sent && entry.follow_up_3_due && entry.follow_up_3_due <= tomorrowStr) {
      dueEntries.push({ entry, fuNum: 3 });
    }
  }

  if (!dueEntries.length) return NextResponse.json({ drafted: 0, message: "No follow-ups due" });

  // Skip entries that already have a pending OR sent draft
  // "sent" guard is a secondary safety net — the primary fix is PATCH writing back to report_entries,
  // but if that write fails for any reason this prevents the same FU being drafted again
  const dueEntryIds = dueEntries.map(d => d.entry.id as string);
  const { data: existingDrafts } = await db()
    .from("drafted_followups")
    .select("entry_id, fu_num, status")
    .in("entry_id", dueEntryIds)
    .in("status", ["pending", "sent"]);

  // Key is entry_id + fu_num so different FU numbers for the same entry are independent
  const alreadyDrafted = new Set(
    (existingDrafts || []).map(d => `${d.entry_id}:${d.fu_num}`)
  );
  const toDraft = dueEntries.filter(
    d => !alreadyDrafted.has(`${d.entry.id as string}:${d.fuNum}`)
  );

  if (!toDraft.length) {
    return NextResponse.json({ drafted: 0, message: `All ${dueEntries.length} due follow-ups already have pending drafts` });
  }

  // Draft each follow-up (sequentially to respect rate limits)
  let drafted = 0;
  const failed: string[] = [];

  for (const { entry, fuNum } of toDraft) {
    try {
      const prompt = getFuPrompt(fuNum, entry);
      const raw = await callClaude(prompt);

      if (!raw.trim()) {
        failed.push(entry.organization as string);
        continue;
      }

      // Parse subject and body
      const subMatch = raw.match(/^SUBJECT:\s*(.+)$/im);
      const subject = subMatch
        ? stripDashes(subMatch[1].trim())
        : `Follow-up ${fuNum} — ${entry.organization}`;
      const body = stripDashes(raw.replace(/^SUBJECT:\s*.+\n*/im, "").trim());

      await db().from("drafted_followups").insert({
        id: crypto.randomUUID(),
        entry_id: entry.id,
        fu_num: fuNum,
        subject,
        body,
        rep_name: entry.rep_name || "",
        status: "pending",
      });

      drafted++;
    } catch {
      failed.push(entry.organization as string);
    }

    await sleep(600); // pace API calls
  }

  return NextResponse.json({
    drafted,
    skipped: alreadyDrafted.size,
    failed: failed.length,
    failedOrgs: failed,
    total: toDraft.length,
  });
}
