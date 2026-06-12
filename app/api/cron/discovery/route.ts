/**
 * Daily Discovery Agent — Cron
 *
 * Runs daily at 6am ET (10:00 UTC) via Vercel cron.
 * For each rep with discovery_enabled = true, finds N new SMERF orgs,
 * runs the full research → scrape → contact → draft pipeline,
 * and stores results in auto_drafts so they're waiting in the app each morning.
 *
 * Supabase tables required (run once in SQL editor):
 *
 * -- Add discovery columns to rep_profiles:
 * alter table rep_profiles add column if not exists discovery_enabled boolean default false;
 * alter table rep_profiles add column if not exists discovery_count integer default 3;
 *
 * -- Auto-drafts table for daily discovered orgs:
 * create table if not exists auto_drafts (
 *   id text primary key,
 *   rep_name text,
 *   org_name text,
 *   org_type text,
 *   contact_name text,
 *   contact_title text,
 *   contact_email text,
 *   contact_source text,
 *   contact_email_verified boolean default false,
 *   subject text,
 *   subject_b text,
 *   body text,
 *   research text,
 *   website text,
 *   status text default 'pending',
 *   dismiss_reason text,
 *   segment_snapshot text,
 *   created_at timestamptz default now()
 * );
 * alter table auto_drafts enable row level security;
 * create policy "allow_all" on auto_drafts for all using (true) with check (true);
 *
 * -- If the table already exists, run these to add missing columns:
 * alter table auto_drafts add column if not exists dismiss_reason text;
 * alter table auto_drafts add column if not exists segment_snapshot text;
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  sleep,
  SMERF_CATEGORIES,
  FALLBACK_CATEGORIES,
  discoverOrgsWithCategory,
  researchOrg,
  scrapeWebsiteContacts,
  findContacts,
  draftEmail,
  mineMissingEmails,
} from "@/lib/discovery-agents";

export const maxDuration = 300;

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// ── Discovery Agent — find new SMERF orgs ────────────────────────────────────
async function discoverOrgs(
  _repName: string,
  _segmentFocus: string,
  existingOrgs: string[],
  count: number
): Promise<{ name: string; type: string; website: string }[]> {
  const dayOfWeek = new Date().getDay();
  const category = SMERF_CATEGORIES[dayOfWeek % SMERF_CATEGORIES.length];

  const result = await discoverOrgsWithCategory(category, existingOrgs, count);
  if (result.length > 0) return result;

  // Primary category returned nothing — try a fallback
  console.log(`[discovery] Primary category "${category}" returned 0 orgs, trying fallback`);
  const fallback = FALLBACK_CATEGORIES[dayOfWeek % FALLBACK_CATEGORIES.length];
  return discoverOrgsWithCategory(fallback, existingOrgs, count);
}

// ── Main cron handler ─────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  // Auth check
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // Load discovery-enabled reps
  const { data: reps, error } = await db()
    .from("rep_profiles")
    .select("rep_name, segment_focus, discovery_count, writing_sample, extracted_style, edit_examples")
    .eq("discovery_enabled", true);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!reps?.length) return NextResponse.json({ ok: true, message: "No reps with discovery enabled" });

  // Run synchronously within maxDuration = 300s (after() was unreliable on Vercel)
  const today = new Date().toISOString().slice(0, 10);

  // Track totals across all reps for a useful response body
  let totalInserted = 0;
  let totalFailed = 0;
  let totalSkippedDedup = 0;
  const repResults: Record<string, unknown>[] = [];

  try {

    for (const rep of reps) {
      // Skip if already ran today for this rep
      const { count: todayCount } = await db()
        .from("auto_drafts")
        .select("*", { count: "exact", head: true })
        .eq("rep_name", rep.rep_name)
        .gte("created_at", today);

      if ((todayCount || 0) > 0) {
        repResults.push({ rep: rep.rep_name, skipped: "already_ran_today", todayCount });
        continue;
      }

      // Build full exclusion list — no cap
      // Exclude: all contacted orgs + all previous discoveries EXCEPT "bad_draft" dismissals
      // (bad_draft = org is still valid, just the email was poor — keep it in the discovery pool)
      const [{ data: contacted, error: contactedErr }, { data: previousDiscoveries, error: prevErr }] = await Promise.all([
        db().from("report_entries").select("organization").eq("rep_name", rep.rep_name),
        db().from("auto_drafts")
          .select("org_name, status, dismiss_reason")
          .eq("rep_name", rep.rep_name)
          .or("status.eq.sent,status.eq.pending,and(status.eq.dismissed,dismiss_reason.neq.bad_draft),and(status.eq.dismissed,dismiss_reason.is.null)"),
      ]);
      if (contactedErr) console.error("[discovery] report_entries query failed:", contactedErr.message);
      if (prevErr) console.error("[discovery] auto_drafts dedup query failed — missing dismiss_reason column?", prevErr.message);
      const existingOrgs = [...new Set([
        ...(contacted || []).map((e: { organization: string }) => e.organization),
        ...(previousDiscoveries || []).map((e: { org_name: string }) => e.org_name),
      ])];

      // Normalise for hard post-filter — strips articles, punctuation, case
      const normalize = (s: string) => s.toLowerCase().replace(/^(the|a|an)\s+/i, "").replace(/[^a-z0-9]/g, "");
      const existingNorm = new Set(existingOrgs.map(normalize));

      // Snapshot segment focus at discovery time for audit trail
      const segmentSnapshot = (rep.segment_focus || "").substring(0, 500);

      // Build style context for email drafting
      const styleContext = rep.writing_sample
        ? `You are ghostwriting for ${rep.rep_name} at Engine. Match their exact voice:\n---\n${rep.writing_sample.substring(0, 600)}\n---\nStyle: ${rep.extracted_style || ""}`
        : `You are writing outreach for ${rep.rep_name} at Engine, a hotel booking platform.`;

      // Step 1: Ask for count*3 candidates so hard filter has enough to work with
      const count = rep.discovery_count || 3;
      const newOrgsRaw = await discoverOrgs(rep.rep_name, rep.segment_focus || "", existingOrgs, count * 3);

      // Hard dedup — DB is the source of truth, not Claude's prompt compliance
      const newOrgs = newOrgsRaw.filter(o => !existingNorm.has(normalize(o.name))).slice(0, count);
      totalSkippedDedup += newOrgsRaw.length - newOrgs.length;

      if (!newOrgs.length) {
        repResults.push({ rep: rep.rep_name, skipped: "all_deduped", candidates: newOrgsRaw.length, excluded: existingOrgs.length, rawCandidates: newOrgsRaw.map(o => o.name) });
        continue;
      }

      let repInserted = 0;
      let repFailed = 0;

      // Step 2: Process each org sequentially
      for (const org of newOrgs) {
        try {
          // Research
          const { research, website: foundWebsite } = await researchOrg(org.name, org.type);
          const website = foundWebsite || org.website || "";

          // Website scrape + contact find in parallel
          const [websiteContacts, discoveredContacts] = await Promise.all([
            website ? scrapeWebsiteContacts(website, org.name) : Promise.resolve([]),
            findContacts(org.name, org.type, website),
          ]);

          // Merge contacts: website first, then discovered, deduped
          const merged = [...websiteContacts, ...discoveredContacts];
          const seen = new Set<string>();
          const contacts = merged.filter(c => {
            const key = c.name.toLowerCase().trim();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }).slice(0, 2); // max 2 contacts per discovered org

          if (!contacts.length) {
            contacts.push({ name: "Program Director", title: "Director of Programs", email: "", source: "Fallback", emailVerified: false });
          }

          // Pass 2: mine emails for any contacts that came back without one
          await mineMissingEmails(org.name, website, contacts);

          // Draft email for each contact
          for (const contact of contacts) {
            const draft = await draftEmail(contact, org.name, org.type, research, styleContext);
            if (!draft.body) continue;

            const row: Record<string, unknown> = {
              id: crypto.randomUUID(),
              rep_name: rep.rep_name,
              org_name: org.name,
              org_type: org.type,
              contact_name: contact.name,
              contact_title: contact.title,
              contact_email: contact.email,
              contact_source: contact.source,
              contact_email_verified: contact.emailVerified,
              subject: draft.subject,
              subject_b: draft.subjectB,
              body: draft.body,
              research,
              website,
              status: "pending",
              segment_snapshot: segmentSnapshot || null,
            };

            let { error: insertErr } = await db().from("auto_drafts").insert(row);

            // If insert failed, it may be because segment_snapshot column doesn't exist yet.
            // Retry without it so the cron keeps working until the migration is applied.
            if (insertErr && insertErr.message?.includes("segment_snapshot")) {
              console.warn(`[discovery] Retrying insert without segment_snapshot (run ALTER TABLE migration): ${insertErr.message}`);
              const { segment_snapshot: _dropped, ...rowWithout } = row as Record<string, unknown> & { segment_snapshot: unknown };
              const retry = await db().from("auto_drafts").insert(rowWithout);
              insertErr = retry.error;
            }

            if (insertErr) {
              console.error(`[discovery] Insert failed for "${org.name}" / "${contact.name}":`, insertErr.message);
              repFailed++;
            } else {
              repInserted++;
              totalInserted++;
            }

            await sleep(500);
          }

          await sleep(800); // pace between orgs
        } catch (err) {
          console.error(`[discovery] Failed processing org "${org.name}":`, err);
          repFailed++;
          totalFailed++;
        }
      }

      repResults.push({ rep: rep.rep_name, inserted: repInserted, failed: repFailed, orgsFound: newOrgs.length, excludedPool: existingOrgs.length });
    }
  } catch (err) {
    console.error("[discovery] Top-level error:", err);
  }

  return NextResponse.json({
    ok: true,
    reps: reps.length,
    message: "Discovery complete",
    totalInserted,
    totalFailed,
    totalSkippedDedup,
    repResults,
  });
}
