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
 *   created_at timestamptz default now()
 * );
 * alter table auto_drafts enable row level security;
 * create policy "allow_all" on auto_drafts for all using (true) with check (true);
 */

import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const maxDuration = 300;

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Rotate SMERF sub-categories by day of week for pipeline diversity
const SMERF_CATEGORIES = [
  "Greek-letter fraternities and sororities (NPC, IFC, NPHC, NALFO) with national headquarters",
  "alumni associations and honor societies with national conventions or member travel programs",
  "veterans organizations and military support groups (VFW, American Legion, AMVETS, TAPS, Blue Star Families)",
  "religious denominations and faith-based nonprofits with annual conferences or staff/member travel",
  "K-12 school districts, private schools, and charter networks that coordinate student and staff travel",
  "professional societies and trade associations with member travel and annual conferences",
  "service organizations with national chapters (Lions, Rotary, Elks, Knights of Columbus) and historically Black Greek-letter organizations (BGLOs)",
];

// ── Discovery Agent — find new SMERF orgs ────────────────────────────────────
async function discoverOrgs(
  repName: string,
  segmentFocus: string,
  existingOrgs: string[],
  count: number
): Promise<{ name: string; type: string; website: string }[]> {
  const dayOfWeek = new Date().getDay();
  const category = SMERF_CATEGORIES[dayOfWeek % SMERF_CATEGORIES.length];

  // Pass full list — truncate by character length to stay within prompt limits, not by count
  const alreadyInFull = existingOrgs.join(", ");
  const alreadyIn = alreadyInFull.length > 6000 ? alreadyInFull.slice(0, 6000) + " ... (more excluded)" : alreadyInFull || "none yet";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY || "",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "web-search-2025-03-05",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
      messages: [{
        role: "user",
        content: `You are finding new SMERF organizations for a hotel partnership outreach pipeline.

Rep context: ${segmentFocus ? segmentFocus.substring(0, 500) : "SMERF organizations in the US"}

Today's focus category: ${category}

Find exactly ${count} organizations that match ALL of these:
- National or regional headquarters with paid staff (Executive Director, CEO, or President)
- Members or staff who travel for conventions, chapter meetings, or programs
- 10-500 members who travel regularly (not too small, not large enough for a full TMC)
- Self-funded travel (members pay their own expenses)
- No obvious existing corporate travel platform
- Based in the United States

Do NOT include organizations already in the pipeline: ${alreadyIn}

Return ONLY valid JSON, no other text:
{"orgs":[{"name":"Full Organization Name","type":"SMERF sub-category","website":"https://www.example.org"}]}`,
      }],
    }),
  });

  if (!res.ok) return [];
  const data = await res.json();
  const text = (data?.content || [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("\n");

  const match = text.match(/\{[\s\S]*"orgs"[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return (parsed.orgs || []).filter((o: { name?: string }) => o.name).slice(0, count);
  } catch { return []; }
}

// ── Research subagent ─────────────────────────────────────────────────────────
async function researchOrg(orgName: string, orgType: string): Promise<{ research: string; website: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY || "",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "web-search-2025-03-05",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 700,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
      messages: [{
        role: "user",
        content: `Research "${orgName}" (${orgType}) for a hotel partnership pitch. Find their primary website URL, events they run, member/network size, and travel patterns.

Return in this EXACT format:
WEBSITE: [full URL]

[4-5 specific facts with real numbers]`,
      }],
    }),
  });
  if (!res.ok) return { research: "", website: "" };
  const data = await res.json();
  const text = (data?.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");
  const websiteMatch = text.match(/^WEBSITE:\s*(.+)$/im);
  const urlFallback = text.match(/https?:\/\/(?:www\.)?[a-zA-Z0-9-]+(?:\.[a-zA-Z]{2,})+/);
  const website = websiteMatch ? websiteMatch[1].trim().replace(/[.,)»"]+$/, "") : urlFallback ? urlFallback[0] : "";
  const research = text.replace(/^WEBSITE:\s*.+\n*/im, "").trim();
  return { research, website };
}

// ── Website Scraper subagent ──────────────────────────────────────────────────
async function scrapeWebsiteContacts(website: string, orgName: string): Promise<{ name: string; title: string; email: string; source: string; emailVerified: boolean }[]> {
  if (!website) return [];
  const base = website.replace(/\/$/, "");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY || "",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "web-search-2025-03-05",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
      messages: [{
        role: "user",
        content: `Find senior staff at "${orgName}" from their website. Visit: ${base}/staff, ${base}/leadership, ${base}/team, ${base}/about, ${base}/board, ${base}/people
Extract senior titles only: Executive Director, CEO, President, COO, VP, Director, Chief.
Return ONLY valid JSON: {"contacts":[{"name":"Full Name","title":"Title","email":"email or empty"}]}
If nothing found: {"contacts":[]}`,
      }],
    }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  const text = (data?.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");
  const match = text.match(/\{[\s\S]*"contacts"[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return (parsed.contacts || []).filter((p: { name?: string; title?: string }) => p.name && p.title).slice(0, 4)
      .map((p: { name: string; title: string; email?: string }) => ({ name: p.name, title: p.title, email: p.email || "", source: "Website", emailVerified: !!(p.email) }));
  } catch { return []; }
}

// ── Contact Finder subagent ───────────────────────────────────────────────────
async function findContacts(orgName: string, orgType: string, domain: string): Promise<{ name: string; title: string; email: string; source: string; emailVerified: boolean }[]> {
  const domainClean = (domain || "").replace(/https?:\/\//i, "").replace(/\/.*$/, "").trim();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY || "",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "web-search-2025-03-05",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      messages: [{
        role: "user",
        content: `Find 2-3 senior decision-makers at "${orgName}" (${orgType}).${domainClean ? ` Website: ${domainClean}` : ""}
Search: site:rocketreach.co "${orgName}" and "${orgName}" executive director president email.
Priority titles: Executive Director, CEO, President, VP Partnerships, Director Business Development, COO.
Return ONLY valid JSON: {"people":[{"name":"Full Name","title":"Title","email":"email or empty","source":"Website|RocketReach|Predicted"}]}`,
      }],
    }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  const text = (data?.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");
  const match = text.match(/\{[\s\S]*"people"[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return (parsed.people || []).filter((p: { name?: string }) => p.name && p.name !== "Unknown").slice(0, 3)
      .map((p: { name: string; title: string; email?: string; source?: string }) => ({
        name: p.name, title: p.title || "Director", email: p.email || "",
        source: p.source || "Web", emailVerified: !!(p.email && !["Pattern", "Predicted"].some(s => (p.source || "").includes(s))),
      }));
  } catch { return []; }
}

function stripDashes(t: string): string {
  return t.replace(/ [—–] /g, ", ").replace(/[—–] /g, "").replace(/ [—–]/g, "").replace(/[—–]/g, ", ");
}

// ── Draft email subagent ──────────────────────────────────────────────────────
async function draftEmail(
  contact: { name: string; title: string },
  orgName: string, orgType: string, research: string, styleContext: string,
  retries = 3
): Promise<{ subject: string; subjectB: string; body: string }> {
  for (let i = 0; i < retries; i++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: `${styleContext}\n\nWrite a partnership outreach email to ${contact.name}, ${contact.title} at ${orgName} (${orgType}).
ENGINE: Hotel booking platform. Say "Engine" never "Engine.com". Hotels only.
VALUE: 1) Preferred hotel rates for org events/members 2) Referral revenue back to the org.
${research ? `RESEARCH:\n${research}\n` : ""}
Angle the pitch to what matters most for a ${contact.title}.
RULES: No em dashes. No generic openers. Short soft ask at end.

SUBJECT_A: [curiosity/question style — org-specific]
SUBJECT_B: [value/direct style — leads with the benefit]

[email body]`,
        }],
      }),
    });
    if (res.status === 429) { await sleep(4000 * (i + 1)); continue; }
    if (!res.ok) return { subject: "", subjectB: "", body: "" };
    const data = await res.json();
    const raw = (data?.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");
    const aMatch = raw.match(/^SUBJECT[_ ]A:\s*(.+)$/im);
    const bMatch = raw.match(/^SUBJECT[_ ]B:\s*(.+)$/im);
    const body = raw.replace(/^SUBJECT[_ ][AB]:\s*.+\n*/gim, "").trim();
    return {
      subject: aMatch ? stripDashes(aMatch[1].trim()) : `${orgName} + Engine`,
      subjectB: bMatch ? stripDashes(bMatch[1].trim()) : "",
      body: stripDashes(body),
    };
  }
  return { subject: "", subjectB: "", body: "" };
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

  // Return immediately — process in background
  after(async () => {
    const today = new Date().toISOString().slice(0, 10);

    for (const rep of reps) {
      // Skip if already ran today for this rep
      const { count: todayCount } = await db()
        .from("auto_drafts")
        .select("*", { count: "exact", head: true })
        .eq("rep_name", rep.rep_name)
        .gte("created_at", today);

      if ((todayCount || 0) > 0) continue;

      // Build full exclusion list — no cap
      // Exclude: all contacted orgs + all previous discoveries EXCEPT "bad_draft" dismissals
      // (bad_draft = org is still valid, just the email was poor — keep it in the discovery pool)
      const [{ data: contacted }, { data: previousDiscoveries }] = await Promise.all([
        db().from("report_entries").select("organization").eq("rep_name", rep.rep_name),
        db().from("auto_drafts")
          .select("org_name, status, dismiss_reason")
          .eq("rep_name", rep.rep_name)
          .or("status.eq.sent,status.eq.pending,and(status.eq.dismissed,dismiss_reason.neq.bad_draft),and(status.eq.dismissed,dismiss_reason.is.null)"),
      ]);
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
      if (!newOrgs.length) continue;

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

          // Draft email for each contact
          for (const contact of contacts) {
            const draft = await draftEmail(contact, org.name, org.type, research, styleContext);
            if (!draft.body) continue;

            await db().from("auto_drafts").insert({
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
              segment_snapshot: segmentSnapshot,
            });

            await sleep(500);
          }

          await sleep(800); // pace between orgs
        } catch { /* skip failed org, continue */ }
      }
    }
  });

  return NextResponse.json({ ok: true, reps: reps.length, message: "Discovery running in background" });
}
