/**
 * Reply Detection Cron — runs daily at 9am UTC (5am ET).
 *
 * Scans Gmail inbox for replies from known prospect email addresses.
 * When a reply is found:
 *   1. Sets replied_at + reply_snippet on the report_entry
 *   2. Auto-moves the stage to "Discovery" (prospect showed interest)
 *   3. Returns a summary of all replies found
 *
 * Requires Gmail credentials in env vars — see /api/gmail/setup for setup.
 * Protected by CRON_SECRET env var (same as other crons).
 *
 * Supabase SQL (run once):
 *   ALTER TABLE report_entries
 *     ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ DEFAULT NULL,
 *     ADD COLUMN IF NOT EXISTS reply_snippet TEXT DEFAULT NULL;
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { findRepliesFrom, gmailConfigured } from "@/lib/gmail";

export const maxDuration = 120;

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

export async function GET(req: NextRequest) {
  // Verify cron authorization
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // Skip if Gmail not configured
  if (!gmailConfigured()) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      message: "Gmail not configured — add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GMAIL_FROM_EMAIL to env vars",
    });
  }

  // Load all sent entries that haven't replied yet and have an email address
  const { data: entries, error } = await db()
    .from("report_entries")
    .select("id, contact_name, organization, email, stage, replied_at")
    .eq("status", "Sent")
    .neq("stage", "Closed Won")
    .neq("stage", "Closed Lost")
    .is("replied_at", null) // only check entries with no reply yet
    .not("email", "is", null)
    .neq("email", "");

  if (error) {
    console.error("[replies] Failed to load entries:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!entries?.length) {
    return NextResponse.json({ ok: true, replied: 0, message: "No active prospects to check" });
  }

  // De-duplicate emails — some contacts may share an address
  const emailToEntries = new Map<string, string[]>();
  for (const entry of entries) {
    const email = entry.email?.toLowerCase().trim();
    if (!email) continue;
    if (!emailToEntries.has(email)) emailToEntries.set(email, []);
    emailToEntries.get(email)!.push(entry.id);
  }

  const uniqueEmails = [...emailToEntries.keys()];
  console.log(`[replies] Checking ${uniqueEmails.length} prospect emails for replies`);

  // Search Gmail for replies from all prospect emails
  let gmailMessages;
  try {
    gmailMessages = await findRepliesFrom(uniqueEmails, 60); // look back 60 days
  } catch (err) {
    console.error("[replies] Gmail search failed:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }

  if (!gmailMessages.length) {
    return NextResponse.json({ ok: true, replied: 0, message: "No replies found in inbox" });
  }

  // Match Gmail messages back to entries
  const repliedEmails = new Set<string>();
  for (const msg of gmailMessages) {
    if (msg.fromEmail) repliedEmails.add(msg.fromEmail);
  }

  // For each email that replied, update all matching entries
  let totalUpdated = 0;
  const repliedOrgs: string[] = [];

  for (const [email, entryIds] of emailToEntries.entries()) {
    if (!repliedEmails.has(email)) continue;

    // Find the most recent message from this email
    const msgs = gmailMessages
      .filter((m) => m.fromEmail === email)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const latestMsg = msgs[0];
    const snippet = latestMsg.snippet.slice(0, 300);
    const repliedAt = new Date().toISOString();

    // Update all entries for this email
    for (const entryId of entryIds) {
      const entry = entries.find((e) => e.id === entryId);

      const { error: updateErr } = await db()
        .from("report_entries")
        .update({
          replied_at: repliedAt,
          reply_snippet: snippet,
          stage: "Discovery", // auto-advance stage when prospect replies
        })
        .eq("id", entryId);

      if (updateErr) {
        console.error(`[replies] Failed to update entry ${entryId}:`, updateErr.message);
      } else {
        totalUpdated++;
        if (entry?.organization) repliedOrgs.push(entry.organization);
        console.log(`[replies] ✓ Reply detected from ${email} (${entry?.organization || "?"})`);
      }
    }
  }

  return NextResponse.json({
    ok: true,
    replied: totalUpdated,
    orgs: repliedOrgs,
    gmailMessagesFound: gmailMessages.length,
    message: totalUpdated
      ? `${totalUpdated} prospect${totalUpdated !== 1 ? "s" : ""} replied: ${repliedOrgs.join(", ")}`
      : "No prospect replies found",
  });
}
