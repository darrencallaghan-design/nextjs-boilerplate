/**
 * Debug endpoint for daily discovery — DELETE after fixing.
 * GET /api/debug-discovery
 * Runs discoverOrgs with the real exclusion list and returns the raw Claude response.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const maxDuration = 60;

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

export async function GET() {
  // Load Darren's exclusion list (same logic as the cron)
  const [{ data: contacted }, { data: previousDiscoveries, error: prevErr }] = await Promise.all([
    db().from("report_entries").select("organization").eq("rep_name", "Darren"),
    db().from("auto_drafts")
      .select("org_name, status, dismiss_reason")
      .eq("rep_name", "Darren")
      .or("status.eq.sent,status.eq.pending,and(status.eq.dismissed,dismiss_reason.neq.bad_draft),and(status.eq.dismissed,dismiss_reason.is.null)"),
  ]);

  if (prevErr) {
    return NextResponse.json({ error: "auto_drafts query failed", detail: prevErr.message });
  }

  const existingOrgs = [...new Set([
    ...(contacted || []).map((e: { organization: string }) => e.organization),
    ...(previousDiscoveries || []).map((e: { org_name: string }) => e.org_name),
  ])];

  const alreadyInFull = existingOrgs.join(", ");
  const alreadyIn = alreadyInFull.length > 6000
    ? alreadyInFull.slice(0, 6000) + " ... (more excluded)"
    : alreadyInFull || "none yet";

  const count = 9;
  const SMERF_CATEGORIES = [
    "Greek-letter fraternities and sororities (NPC, IFC, NPHC, NALFO) with national headquarters",
    "alumni associations and honor societies with national conventions or member travel programs",
    "veterans organizations and military support groups (VFW, American Legion, AMVETS, TAPS, Blue Star Families)",
    "religious denominations and faith-based nonprofits with annual conferences or staff/member travel",
    "K-12 school districts, private schools, and charter networks that coordinate student and staff travel",
    "professional societies and trade associations with member travel and annual conferences",
    "service organizations with national chapters (Lions, Rotary, Elks, Knights of Columbus) and historically Black Greek-letter organizations (BGLOs)",
  ];
  const dayOfWeek = new Date().getDay();
  const category = SMERF_CATEGORIES[dayOfWeek % SMERF_CATEGORIES.length];

  const prompt = `Find exactly ${count} NEW US SMERF organizations for hotel partnership outreach. SMERF = Social, Military, Educational, Religious, Fraternal.

Today's focus: ${category}

Requirements:
- National headquarters with paid staff (Executive Director, CEO, or President)
- Members/staff travel for conventions, chapter meetings, or programs
- Based in the United States

EXCLUDE (already in pipeline): ${alreadyIn}

CRITICAL: Your entire response must be ONLY the JSON object below — no prose, no numbered list, no explanation before or after:
{"orgs":[{"name":"Full Organization Name","type":"SMERF sub-category","website":"https://www.example.org"}]}`;

  const apiKey = process.env.ANTHROPIC_API_KEY || "";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "web-search-2025-03-05",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const status = res.status;
  const rawText = await res.text();

  let stopReason = "";
  let textBlocks: string[] = [];
  let contentTypes: string[] = [];
  let orgsFound = 0;
  let parseError = "";

  try {
    const data = JSON.parse(rawText);
    stopReason = data?.stop_reason || "";
    contentTypes = (data?.content || []).map((b: { type: string }) => b.type);
    textBlocks = (data?.content || [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text);

    const fullText = textBlocks.join("\n");
    // Try extractOrgsJson logic
    try {
      const direct = JSON.parse(fullText.trim());
      if (Array.isArray(direct?.orgs)) { orgsFound = direct.orgs.length; }
    } catch {
      const start = fullText.lastIndexOf('{"orgs"');
      if (start !== -1) {
        let depth = 0, end = -1;
        for (let i = start; i < fullText.length; i++) {
          if (fullText[i] === "{") depth++;
          else if (fullText[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end !== -1) {
          try {
            const parsed = JSON.parse(fullText.slice(start, end + 1));
            orgsFound = (parsed.orgs || []).length;
          } catch (e) {
            parseError = String(e);
          }
        }
      }
    }
  } catch (e) {
    parseError = String(e);
  }

  const allTextContent = textBlocks.join("\n");

  return NextResponse.json({
    excludedCount: existingOrgs.length,
    alreadyInLength: alreadyIn.length,
    category,
    promptLength: prompt.length,
    httpStatus: status,
    stopReason,
    contentTypes,
    textBlockCount: textBlocks.length,
    allTextContent: allTextContent.slice(0, 2000),
    orgsFound,
    parseError,
    rawApiPreview: rawText.slice(0, 800),
  });
}
