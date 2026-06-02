/**
 * AI Search — synchronous discovery pipeline driven by a natural language query.
 *
 * POST /api/search
 * Body: { query: string; repName: string }
 * Returns: { results: SearchOrgResult[]; count: number; message: string }
 *
 * Runs the full pipeline (discover → research → contacts → draft) synchronously,
 * same pattern as the daily discovery cron which runs up to 300s reliably.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  sleep,
  discoverOrgsWithCategory,
  researchOrg,
  scrapeWebsiteContacts,
  findContacts,
  draftEmail,
} from "@/lib/discovery-agents";

export const maxDuration = 300;

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

/** Translate a natural-language query into a discovery category string via Claude. */
async function translateQueryToCategory(query: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY || "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{
        role: "user",
        content: `You are a SMERF (Social, Military, Educational, Religious, Fraternal) travel segment expert. Convert the user's search query into a concise discovery category string suitable for finding matching US organizations.

Extract from the query: org types, size/member signals, travel patterns, geography.
Return a single descriptive category string (1-2 sentences, no JSON, no bullets).

User query: ${query}

Category string:`,
      }],
    }),
  });

  if (!res.ok) return query;
  const data = await res.json();
  const text = (data?.content || [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("\n")
    .trim();
  return text || query;
}

interface SearchOrgResult {
  id: string;
  org_name: string;
  org_type: string;
  website: string;
  research: string;
  contact_name: string;
  contact_title: string;
  contact_email: string;
  subject: string;
  body: string;
}

export async function POST(req: NextRequest) {
  let body: { query?: string; repName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { query, repName } = body;
  if (!query?.trim()) {
    return NextResponse.json({ error: "query is required" }, { status: 400 });
  }

  const supabase = db();
  const repNameSafe = repName || "Darren";

  // Load rep profile for style context
  const { data: profileRows } = await supabase
    .from("rep_profiles")
    .select("rep_name, segment_focus, writing_sample, extracted_style, edit_examples")
    .eq("rep_name", repNameSafe)
    .limit(1);

  const rep = profileRows?.[0] || null;
  const styleContext = rep?.writing_sample
    ? `You are ghostwriting for ${repNameSafe} at Engine. Match their exact voice:\n---\n${rep.writing_sample.substring(0, 600)}\n---\nStyle: ${rep.extracted_style || ""}`
    : `You are writing outreach for ${repNameSafe} at Engine, a hotel booking platform.`;

  // Load all existing orgs for DB-level dedup (prevents duplicate inserts).
  // We do NOT pass these to Claude — the pipeline has 190+ orgs and passing that list
  // causes Claude to return 0 results even for valid categories.
  // Claude searches freely; JS handles dedup before inserting.
  const [{ data: contacted }, { data: allDrafts }] = await Promise.all([
    supabase.from("report_entries").select("organization").eq("rep_name", repNameSafe),
    supabase.from("auto_drafts").select("org_name").eq("rep_name", repNameSafe),
  ]);

  const normalize = (s: string) => s.toLowerCase().replace(/^(the|a|an)\s+/i, "").replace(/[^a-z0-9]/g, "");

  // Full set for DB-level dedup at insert time only
  const allExistingNorm = new Set([
    ...(contacted || []).map((e: { organization: string }) => normalize(e.organization)),
    ...(allDrafts || []).map((e: { org_name: string }) => normalize(e.org_name)),
  ]);

  // Translate query to category
  const category = await translateQueryToCategory(query.trim());

  // Discover orgs with NO exclusion list — Claude gets full freedom to search the web
  // for orgs matching the user's query. Dedup happens in JS below.
  // Ask for 9 to have buffer; cap final results at 5.
  const rawOrgs = await discoverOrgsWithCategory(category, [], 9);

  // Hard dedup against ALL existing orgs in DB — no duplicate inserts
  const orgs = rawOrgs.filter(o => !allExistingNorm.has(normalize(o.name))).slice(0, 5);

  if (!orgs.length) {
    const allRawNorm = rawOrgs.map(o => normalize(o.name));
    const allInPipeline = allRawNorm.every(n => allExistingNorm.has(n));
    const message = rawOrgs.length > 0 && allInPipeline
      ? `All ${rawOrgs.length} found org${rawOrgs.length !== 1 ? "s" : ""} already in your pipeline.`
      : "No orgs found. Try a broader or different search.";
    return NextResponse.json({ results: [], count: 0, message, _debug: { category, rawFound: rawOrgs.length, existingInDB: allExistingNorm.size, rawOrgs: rawOrgs.map(o => o.name) } });
  }

  const results: SearchOrgResult[] = [];

  for (const org of orgs) {
    try {
      const { research, website: foundWebsite } = await researchOrg(org.name, org.type);
      const website = foundWebsite || org.website || "";

      const [websiteContacts, discoveredContacts] = await Promise.all([
        website ? scrapeWebsiteContacts(website, org.name) : Promise.resolve([]),
        findContacts(org.name, org.type, website),
      ]);

      const merged = [...websiteContacts, ...discoveredContacts];
      const seen = new Set<string>();
      const contacts = merged.filter(c => {
        const key = c.name.toLowerCase().trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 2);

      if (!contacts.length) {
        contacts.push({ name: "Program Director", title: "Director of Programs", email: "", source: "Fallback", emailVerified: false });
      }

      const contact = contacts[0];
      const draft = await draftEmail(contact, org.name, org.type, research, styleContext);
      if (!draft.body) continue;

      const id = crypto.randomUUID();
      const row: Record<string, unknown> = {
        id,
        rep_name: repNameSafe,
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
        segment_snapshot: `ai_search: ${query.slice(0, 200)}`,
      };

      let { error: insertErr } = await supabase.from("auto_drafts").insert(row);
      if (insertErr?.message?.includes("segment_snapshot")) {
        const { segment_snapshot: _dropped, ...rowWithout } = row as Record<string, unknown> & { segment_snapshot: unknown };
        const retry = await supabase.from("auto_drafts").insert(rowWithout);
        insertErr = retry.error;
      }

      if (!insertErr) {
        results.push({ id, org_name: org.name, org_type: org.type, website, research, contact_name: contact.name, contact_title: contact.title, contact_email: contact.email, subject: draft.subject, body: draft.body });
      }

      await sleep(400);
    } catch (err) {
      console.error(`[search] Failed processing "${org.name}":`, err);
    }
  }

  return NextResponse.json({
    results,
    count: results.length,
    message: `Found ${results.length} org${results.length !== 1 ? "s" : ""} — added to Discovered.`,
  });
}
