/**
 * AI Search — synchronous discovery pipeline driven by a natural language query.
 *
 * POST /api/search
 * Body: { query: string; repName: string }
 * Returns: { results: SearchOrgResult[]; count: number; message: string }
 *
 * Strategy:
 * 1. Claude searches the web freely (no exclusion list — passing 190+ orgs breaks it)
 * 2. New orgs (not in DB) → run full pipeline and insert
 * 3. Orgs already in pipeline → surface from DB directly (show with "in pipeline" flag)
 * 4. Result = new + surfaced, capped at 5 total
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
  mineMissingEmails,
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
  inPipeline?: boolean;
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

  // Load all existing org names — used for dedup (not passed to Claude)
  const [{ data: contacted }, { data: allDrafts }] = await Promise.all([
    supabase.from("report_entries").select("organization").eq("rep_name", repNameSafe),
    supabase.from("auto_drafts")
      .select("id, org_name, org_type, website, research, contact_name, contact_title, contact_email, subject, body, status")
      .eq("rep_name", repNameSafe),
  ]);

  const normalize = (s: string) => s.toLowerCase().replace(/^(the|a|an)\s+/i, "").replace(/[^a-z0-9]/g, "");

  const contactedNorm = new Set((contacted || []).map((e: { organization: string }) => normalize(e.organization)));

  // Map of normalized name → best existing draft (prefer pending over dismissed)
  const draftsByNorm = new Map<string, Record<string, unknown>>();
  for (const d of (allDrafts || []) as Record<string, unknown>[]) {
    const n = normalize(d.org_name as string);
    const existing = draftsByNorm.get(n);
    // Keep pending > dismissed priority
    if (!existing || (d.status === "pending" && existing.status !== "pending")) {
      draftsByNorm.set(n, d);
    }
  }

  // Translate query to category
  const category = await translateQueryToCategory(query.trim());

  // Claude searches freely — no exclusion list (passing 190+ orgs causes it to return 0)
  // Retry once with raw query if category translation returns nothing
  let rawOrgs = await discoverOrgsWithCategory(category, [], 9);
  if (!rawOrgs.length) {
    await sleep(1500);
    rawOrgs = await discoverOrgsWithCategory(query.trim(), [], 9);
  }

  if (!rawOrgs.length) {
    return NextResponse.json({ results: [], count: 0, message: "No orgs found. Try a different search." });
  }

  const results: SearchOrgResult[] = [];

  // Separate: orgs already in pipeline vs genuinely new
  const newOrgs = rawOrgs.filter(o => !draftsByNorm.has(normalize(o.name)) && !contactedNorm.has(normalize(o.name)));
  const pipelineOrgs = rawOrgs.filter(o => draftsByNorm.has(normalize(o.name)));

  // Run full pipeline on new orgs (up to 5 total budget)
  for (const org of newOrgs.slice(0, 5)) {
    if (results.length >= 5) break;
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

      // Pass 2: mine emails for any contacts that came back without one
      await mineMissingEmails(org.name, website, contacts);

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

  // Fill remaining slots with pipeline orgs (already have research + drafts)
  for (const org of pipelineOrgs) {
    if (results.length >= 5) break;
    const existing = draftsByNorm.get(normalize(org.name));
    if (!existing) continue;
    results.push({
      id: existing.id as string,
      org_name: existing.org_name as string,
      org_type: existing.org_type as string,
      website: existing.website as string || "",
      research: existing.research as string || "",
      contact_name: existing.contact_name as string || "",
      contact_title: existing.contact_title as string || "",
      contact_email: existing.contact_email as string || "",
      subject: existing.subject as string || "",
      body: existing.body as string || "",
      inPipeline: true,
    });
  }

  const newCount = results.filter(r => !r.inPipeline).length;
  const pipelineCount = results.filter(r => r.inPipeline).length;

  let message = "";
  if (newCount > 0 && pipelineCount > 0) {
    message = `${newCount} new org${newCount !== 1 ? "s" : ""} added to Discovered, ${pipelineCount} already in your pipeline.`;
  } else if (newCount > 0) {
    message = `Found ${newCount} new org${newCount !== 1 ? "s" : ""} — added to Discovered.`;
  } else if (pipelineCount > 0) {
    message = `${pipelineCount} org${pipelineCount !== 1 ? "s" : ""} found — already in your pipeline.`;
  } else {
    message = "No results found. Try a different search.";
  }

  return NextResponse.json({ results, count: results.length, message });
}
