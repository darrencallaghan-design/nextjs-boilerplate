import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// auto_drafts table — run once in Supabase SQL editor:
//
// CREATE TABLE IF NOT EXISTS auto_drafts (
//   id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
//   rep_name               TEXT        NOT NULL,
//   org_name               TEXT        NOT NULL,
//   org_type               TEXT        NOT NULL DEFAULT '',
//   contact_name           TEXT        NOT NULL DEFAULT '',
//   contact_title          TEXT        NOT NULL DEFAULT '',
//   contact_email          TEXT        NOT NULL DEFAULT '',
//   contact_source         TEXT        NOT NULL DEFAULT '',
//   contact_email_verified BOOLEAN     DEFAULT FALSE,
//   subject                TEXT        NOT NULL DEFAULT '',
//   subject_b              TEXT        NOT NULL DEFAULT '',
//   body                   TEXT        NOT NULL DEFAULT '',
//   research               TEXT        NOT NULL DEFAULT '',
//   website                TEXT        NOT NULL DEFAULT '',
//   status                 TEXT        NOT NULL DEFAULT 'pending',
//   created_at             TIMESTAMPTZ DEFAULT NOW()
// );
// ALTER TABLE auto_drafts ENABLE ROW LEVEL SECURITY;
// CREATE POLICY "allow_all" ON auto_drafts FOR ALL USING (true) WITH CHECK (true);

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// Pro plan: serverless, 60s
export const maxDuration = 60;

// GET /api/discover?rep=Darren&status=pending
// Returns auto_drafts for a rep (defaults to pending)
export async function GET(req: NextRequest) {
  const repName = req.nextUrl.searchParams.get("rep");
  const status  = req.nextUrl.searchParams.get("status") || "pending";

  if (!repName) {
    return NextResponse.json({ error: "Missing rep param" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("auto_drafts")
    .select("*")
    .eq("rep_name", repName)
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ drafts: data || [] });
}

// PATCH /api/discover — update status of an auto_draft
// status: "sent" | "dismissed"
// dismiss_reason: "wrong_org" (exclude permanently) | "bad_draft" (org stays in pool)
export async function PATCH(req: NextRequest) {
  const { id, status, dismiss_reason } = await req.json();

  if (!id || !status) {
    return NextResponse.json({ error: "Missing id or status" }, { status: 400 });
  }

  const update: Record<string, string> = { status };
  if (dismiss_reason) update.dismiss_reason = dismiss_reason;

  const { error } = await supabase
    .from("auto_drafts")
    .update(update)
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

// Discovers real similar organizations using live web search.
// Uses the rep's segment focus to stay in their industry, and
// excludes orgs already in their pipeline to avoid duplicates.
export async function POST(req: NextRequest) {
  const { startingOrg, segmentFocus, excludeOrgs = [] } = await req.json();

  const excludeSection =
    excludeOrgs.length > 0
      ? `\n\nIMPORTANT — Do NOT return any of these organizations (already in pipeline):\n${excludeOrgs.slice(0, 30).join(", ")}`
      : "";

  const segmentSection = segmentFocus?.trim()
    ? `\n\nThis rep's industry focus and target segment:\n"""\n${segmentFocus.trim()}\n"""\nStay within this segment. Find organizations that match the types of companies and partnerships described above.`
    : "";

  const userMessage = `You are helping a partnerships rep at Engine find new prospect organizations. Engine is a hotel booking platform — it helps organizations manage lodging for their drivers, crews, members, or traveling employees.

The rep wants to find organizations SIMILAR TO: "${startingOrg}"${segmentSection}

Search the web for 10 REAL organizations that:
1. Are similar in type/category to "${startingOrg}"
2. Have members, employees, drivers, or contractors who regularly need hotel lodging
3. Would benefit from a hotel booking partnership with Engine
4. Are real, verifiable organizations with a web presence${excludeSection}

Return DIVERSE results — mix different sub-types and sizes within the segment. Do not return 10 companies that are all exactly the same category.

Search for actual company names, verify they exist, and return only real organizations.

Return ONLY valid JSON with no extra text:
{"orgs":[{"name":"Full Organization Name","type":"Category e.g. TMS Platform, Trucking Association, Fleet Payment Provider, Factoring Company","why":"One sentence on why they need hotel lodging and are a good Engine fit"}]}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY || "",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "web-search-2025-03-05",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok) {
    return NextResponse.json({ orgs: [] }, { status: res.status });
  }

  const data = await res.json();
  const textBlocks = (data?.content || [])
    .filter((b: { type: string }) => b?.type === "text")
    .map((b: { text: string }) => b.text)
    .join("\n");

  // Extract JSON from response
  const jsonMatch = textBlocks.match(/\{[\s\S]*"orgs"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const orgs = (parsed.orgs || []).slice(0, 10);
      return NextResponse.json({ orgs });
    } catch {
      /* fall through */
    }
  }

  return NextResponse.json({ orgs: [] });
}
