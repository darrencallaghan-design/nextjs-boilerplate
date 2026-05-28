/**
 * Gmail Sent Reconstruction — /api/gmail/reconstruct
 *
 * Scans your Gmail Sent folder for Engine outreach emails sent in a given
 * date range and adds any that are missing from report_entries.
 *
 * Usage:
 *   GET /api/gmail/reconstruct                    → last 7 days (dry-run preview)
 *   GET /api/gmail/reconstruct?days=30            → look back 30 days
 *   GET /api/gmail/reconstruct?commit=true        → actually insert missing rows
 *   GET /api/gmail/reconstruct?date=2026-05-18    → single day only
 *
 * How it works:
 *   1. Fetches up to 200 messages from Gmail Sent folder
 *   2. Filters to ones that look like outreach (exclude internal @engine.com threads)
 *   3. Cross-checks against report_entries by (email address OR subject line)
 *   4. Returns missing ones so you can review, or inserts them if ?commit=true
 *
 * Requires Gmail OAuth env vars — see /api/gmail/setup to set up.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAccessToken, gmailConfigured } from "@/lib/gmail";

export const maxDuration = 60;

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

interface SentMessage {
  id: string;
  threadId: string;
  to: string;
  toEmail: string;
  subject: string;
  date: string;
  snippet: string;
}

async function getSentMessages(query: string, maxResults = 200): Promise<SentMessage[]> {
  const token = await getAccessToken();

  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!listRes.ok) throw new Error(`Gmail list failed: ${listRes.status}`);

  const list = await listRes.json();
  const messages: { id: string; threadId: string }[] = list.messages || [];
  if (!messages.length) return [];

  // Fetch metadata in parallel (batches of 20 to avoid rate limits)
  const BATCH = 20;
  const results: SentMessage[] = [];

  for (let i = 0; i < messages.length; i += BATCH) {
    const batch = messages.slice(i, i + BATCH);
    const details = await Promise.all(
      batch.map(async (msg) => {
        const detRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=To&metadataHeaders=Date&metadataHeaders=Subject`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!detRes.ok) return null;

        const det = await detRes.json();
        const headers: { name: string; value: string }[] = det.payload?.headers || [];
        const getH = (name: string) =>
          headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

        const toRaw = getH("To");
        const emailMatch = toRaw.match(/<([^>]+)>/) || toRaw.match(/\S+@\S+/);
        const toEmail = (emailMatch ? emailMatch[1] || emailMatch[0] : toRaw).toLowerCase().trim();

        return {
          id: msg.id,
          threadId: msg.threadId,
          to: toRaw,
          toEmail,
          subject: getH("Subject"),
          date: getH("Date"),
          snippet: (det.snippet || "").replace(/&#39;/g, "'").replace(/&amp;/g, "&"),
        } as SentMessage;
      })
    );
    results.push(...(details.filter(Boolean) as SentMessage[]));

    // Small pause between batches
    if (i + BATCH < messages.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return results;
}

export async function GET(req: NextRequest) {
  if (!gmailConfigured()) {
    return NextResponse.json({
      error: "Gmail not configured",
      setup: "Visit /api/gmail/setup to connect your Gmail account",
    }, { status: 400 });
  }

  const params = req.nextUrl.searchParams;
  const commit = params.get("commit") === "true";
  const singleDate = params.get("date"); // e.g. 2026-05-18
  const days = parseInt(params.get("days") || "7", 10);

  // Build Gmail query
  let gmailQuery: string;
  if (singleDate) {
    // Gmail after/before use YYYY/MM/DD format
    const d = new Date(singleDate);
    const next = new Date(d);
    next.setDate(d.getDate() + 1);
    const fmt = (dt: Date) => `${dt.getFullYear()}/${String(dt.getMonth()+1).padStart(2,'0')}/${String(dt.getDate()).padStart(2,'0')}`;
    gmailQuery = `in:sent after:${fmt(d)} before:${fmt(next)} -to:@engine.com`;
  } else {
    gmailQuery = `in:sent newer_than:${days}d -to:@engine.com`;
  }

  let sentMessages: SentMessage[];
  try {
    sentMessages = await getSentMessages(gmailQuery, 200);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }

  if (!sentMessages.length) {
    return NextResponse.json({ found: 0, missing: 0, message: "No sent emails found in that date range" });
  }

  // Load existing report_entries emails + subject lines for dedup
  const { data: existing } = await db()
    .from("report_entries")
    .select("email, subject_line")
    .eq("rep_name", "Darren");

  const existingEmails = new Set((existing || []).map(e => e.email?.toLowerCase().trim()).filter(Boolean));
  const existingSubjects = new Set((existing || []).map(e => e.subject_line?.toLowerCase().trim()).filter(Boolean));

  // Find missing ones
  const missing = sentMessages.filter(msg => {
    if (!msg.toEmail || msg.toEmail.includes("@engine.com")) return false;
    const subjectLower = msg.subject.toLowerCase().trim();
    // Skip if email or subject already in report_entries
    if (existingEmails.has(msg.toEmail)) return false;
    if (existingSubjects.has(subjectLower)) return false;
    return true;
  });

  if (!missing.length) {
    return NextResponse.json({
      found: sentMessages.length,
      missing: 0,
      message: "All sent emails are already in report_entries — nothing to reconstruct",
    });
  }

  if (!commit) {
    // Dry run — return preview
    return NextResponse.json({
      found: sentMessages.length,
      missing: missing.length,
      dryRun: true,
      message: `Found ${missing.length} sent emails not in report_entries. Add ?commit=true to insert them.`,
      preview: missing.slice(0, 20).map(m => ({
        to: m.to,
        subject: m.subject,
        date: m.date,
        snippet: m.snippet.slice(0, 100),
      })),
    });
  }

  // Commit mode — insert missing rows
  const inserted: string[] = [];
  const failed: string[] = [];

  for (const msg of missing) {
    try {
      // Parse date
      const sentDate = new Date(msg.date);
      const dateStr = sentDate.toISOString().slice(0, 10);

      // Derive follow-up dates
      const fu1 = new Date(sentDate); fu1.setDate(sentDate.getDate() + 5);
      const fu2 = new Date(sentDate); fu2.setDate(sentDate.getDate() + 9);
      const fu3 = new Date(sentDate); fu3.setDate(sentDate.getDate() + 15);

      // Best-effort contact name from To field: "First Last <email>" → "First Last"
      const nameMatch = msg.to.match(/^"?([^"<]+)"?\s*</);
      const contactName = nameMatch ? nameMatch[1].trim() : msg.toEmail.split("@")[0];

      // Org from email domain (strip common subdomains)
      const domain = msg.toEmail.split("@")[1] || "";
      const orgGuess = domain
        .replace(/^(mail|info|contact|hello)\./i, "")
        .replace(/\.(com|org|net|edu|gov)$/, "")
        .split(".")[0];
      const orgName = orgGuess.charAt(0).toUpperCase() + orgGuess.slice(1);

      const { error: insertErr } = await db().from("report_entries").insert({
        id: crypto.randomUUID(),
        rep_name: "Darren",
        wave: 1,
        organization: orgName,
        contact_name: contactName,
        email: msg.toEmail,
        subject_line: msg.subject,
        date_sent: dateStr,
        status: "Sent",
        stage: "Outreach",
        follow_up_due: fu1.toISOString().slice(0, 10),
        follow_up_2_due: fu2.toISOString().slice(0, 10),
        follow_up_3_due: fu3.toISOString().slice(0, 10),
        follow_up_sent: false,
        follow_up_2_sent: false,
        follow_up_3_sent: false,
        source: "Gmail Reconstruct",
        created_at: sentDate.toISOString(),
      });

      if (insertErr) {
        console.error(`[reconstruct] Insert failed for ${msg.toEmail}:`, insertErr.message);
        failed.push(msg.toEmail);
      } else {
        inserted.push(`${contactName} <${msg.toEmail}> — ${msg.subject}`);
      }
    } catch (err) {
      console.error(`[reconstruct] Error for ${msg.toEmail}:`, err);
      failed.push(msg.toEmail);
    }
  }

  return NextResponse.json({
    found: sentMessages.length,
    missing: missing.length,
    inserted: inserted.length,
    failed: failed.length,
    insertedList: inserted,
    failedList: failed,
    message: `Reconstructed ${inserted.length} entries from Gmail Sent folder`,
  });
}
