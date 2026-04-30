import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const maxDuration = 300;

const KEY = () => process.env.ANTHROPIC_API_KEY || "";

// ─── Supabase job store ───────────────────────────────────────────────────────
// Shared across all Vercel instances — fixes cross-instance poll misses.
//
// Run this ONCE in your Supabase SQL editor to create the table:
//
// create table if not exists partner_jobs (
//   id text primary key,
//   status text not null default 'processing',
//   brief jsonb,
//   error text,
//   created_at timestamptz default now()
// );
// alter table partner_jobs enable row level security;
// create policy "allow_all" on partner_jobs for all using (true) with check (true);

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// In-memory fallback — same-instance polls still skip the Supabase round-trip
const memStore = new Map<string, { status: "processing" | "done" | "error"; brief?: object; error?: string; created: number }>();

async function jobSet(id: string, status: "processing" | "done" | "error", brief?: object, error?: string) {
  memStore.set(id, { status, brief, error, created: Date.now() });
  try {
    await db().from("partner_jobs").upsert({ id, status, brief: brief ?? null, error: error ?? null });
  } catch { /* Supabase write failure — in-memory still works for same-instance polls */ }
}

async function jobGet(id: string): Promise<{ status: "processing" | "done" | "error"; brief?: object; error?: string } | null> {
  // 1. Check in-memory first (fastest — same instance)
  const mem = memStore.get(id);
  if (mem) return mem;

  // 2. Fall back to Supabase (cross-instance case)
  try {
    const { data } = await db().from("partner_jobs").select("status,brief,error").eq("id", id).single();
    if (!data) return null;
    return { status: data.status, brief: data.brief ?? undefined, error: data.error ?? undefined };
  } catch { return null; }
}

function cleanupMem() {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [id, job] of memStore.entries()) {
    if (job.created < cutoff) memStore.delete(id);
  }
}

// ─── Research function ────────────────────────────────────────────────────────

async function researchAndSynthesize(company: string, domain: string, notes: string, segmentFocus: string): Promise<string> {
  const domainHint = domain ? ` (${domain})` : "";

  const smerfContext = `SMERF channel (Social · Military · Educational · Religious · Fraternal).
SMERF orgs: alumni associations, civic groups, veterans orgs, Greek life, faith-based orgs, unions, membership societies, school/university travel programs, nonprofit conferences, mission/retreat groups.
SMERF travel pattern: group room blocks for conventions, retreats, conferences, reunions, seminars, mission trips — consistent year-round including off-peak. Budget-conscious but loyal.`;

  const channelContext = segmentFocus && segmentFocus.toLowerCase() !== "smerf"
    ? `Rep's channel: ${segmentFocus}`
    : smerfContext;

  const prompt = `You are a senior partnerships analyst at Engine. Research "${company}"${domainHint} thoroughly and build a complete partner brief.

ENGINE CONTEXT:
Engine = hotel booking for organizations. 1% rev share for partners. Members save 22% on hotels. SMERF focus.
${notes ? `\nREP NOTES: ${notes}` : ""}
SEGMENT CONTEXT: ${channelContext}

Search then extract: actual event names + attendance, member count, existing programs, real cities, travel patterns, recent 2024-25 news.

Fit score 0-100:
+20 member network 200+
+15 recurring travel events
+15 SMERF match
+15 work-tied travel
+10 existing partner program
+10 national footprint
+5 value fit
-15 consumer-only
-10 occasional travel only
Strong>=65, Potential>=35, Low<35

Pitch angles must reference real facts. Talking points must use specific data (event names, numbers).

Return ONLY valid JSON (no markdown, no explanation):
{"snapshot":{"name":"","industry":"","size":"","locations":"","description":"","website":""},"fitScore":0,"fitTier":"Potential","fitSignals":["specific signal","signal 2","signal 3","signal 4"],"distribution":{"networkType":"","networkSize":"","events":["Event, City, attendees","Event 2","Event 3"],"programs":["Program","Program 2"]},"valueProps":[{"headline":"","bullets":["bullet","bullet 2","bullet 3"]},{"headline":"","bullets":["bullet","bullet 2","bullet 3"]}],"pitchAngles":[{"angle":"","why":"","openingLine":"specific opening"},{"angle":"","why":"","openingLine":"opening 2"}],"talkingPoints":["specific tp with data","tp 2","tp 3","tp 4","tp 5"],"recentNews":[{"headline":"","date":""},{"headline":"","date":""}],"engineAngle":"specific compelling angle"}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": KEY(),
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "web-search-2025-03-05",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 2500,
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (res.status === 429) { await new Promise(r => setTimeout(r, 2000)); continue; }
      if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const blocks: { type: string; text?: string }[] = data.content || [];
      const textBlocks = blocks.filter(b => b.type === "text" && b.text);
      for (const block of [...textBlocks].reverse()) {
        const t = block.text || "";
        if (t.includes('"fitScore"') || t.includes('"snapshot"') || t.includes('"fitTier"')) {
          return t;
        }
      }
      return textBlocks.map(b => b.text).join("\n");
    } catch (err) {
      if (attempt === 1) throw err;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error("Max retries exceeded");
}

async function enrichZoomInfo(company: string): Promise<Record<string, unknown> | null> {
  const mcpUrl = process.env.ZOOMINFO_MCP_URL;
  if (!mcpUrl) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": KEY(), "anthropic-version": "2023-06-01", "anthropic-beta": "mcp-client-2025-04-04" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 600, mcp_servers: [{ type: "url", url: mcpUrl, name: "zoominfo", ...(process.env.ZOOMINFO_MCP_API_KEY ? { authorization_token: process.env.ZOOMINFO_MCP_API_KEY } : {}) }], messages: [{ role: "user", content: `Use enrich_companies to look up "${company}". Return ONLY JSON: {name,industry,employeeCount,numberOfLocations,description,website}` }] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = (data.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

async function checkCrossbeam(company: string): Promise<{ partnerName: string; overlapType: string }[]> {
  const cbKey = process.env.CROSSBEAM_API_KEY;
  if (!cbKey) return [];
  try {
    const [pRes, aRes] = await Promise.all([
      fetch(`https://api.crossbeam.com/v0.2/partners?limit=50`, { headers: { Authorization: `Bearer ${cbKey}` } }),
      fetch(`https://api.crossbeam.com/v0.2/account-details?account_name=${encodeURIComponent(company)}`, { headers: { Authorization: `Bearer ${cbKey}` } }),
    ]);
    if (!pRes.ok || !aRes.ok) return [];
    const [pData, aData] = await Promise.all([pRes.json(), aRes.json()]);
    const partners: { uuid: string; name: string }[] = pData.items || pData.data || [];
    const accounts = aData.items || aData.data || [];
    if (!accounts.length) return [];
    const overlaps: string[] = accounts[0]?.partner_overlaps?.map((o: { partner_uuid: string }) => o.partner_uuid) || [];
    return overlaps.slice(0, 3).map((uuid: string) => ({ partnerName: partners.find(p => p.uuid === uuid)?.name || "Engine Partner", overlapType: "Account overlap — warm path available" }));
  } catch { return []; }
}

function buildBrief(parsed: Record<string, unknown>, ziData: Record<string, unknown> | null, cbSignals: { partnerName: string; overlapType: string }[], company: string, domain: string) {
  const snapshot = {
    name: String(ziData?.name || (parsed.snapshot as Record<string, unknown>)?.name || company),
    industry: String(ziData?.industry || (parsed.snapshot as Record<string, unknown>)?.industry || ""),
    size: ziData?.employeeCount ? `${Number(ziData.employeeCount).toLocaleString()} employees` : String((parsed.snapshot as Record<string, unknown>)?.size || ""),
    locations: ziData?.numberOfLocations ? `${ziData.numberOfLocations} locations` : String((parsed.snapshot as Record<string, unknown>)?.locations || ""),
    description: String(ziData?.description || (parsed.snapshot as Record<string, unknown>)?.description || ""),
    website: String(ziData?.website || (parsed.snapshot as Record<string, unknown>)?.website || domain || ""),
  };
  return {
    companySnapshot: snapshot,
    partnershipFit: { score: Number(parsed.fitScore || 0), tier: (parsed.fitTier || "Potential") as "Strong" | "Potential" | "Low", signals: Array.isArray(parsed.fitSignals) ? parsed.fitSignals : [] },
    distributionPower: { networkSize: String((parsed.distribution as Record<string, unknown>)?.networkSize || "Unknown"), networkType: String((parsed.distribution as Record<string, unknown>)?.networkType || "Unknown"), events: Array.isArray((parsed.distribution as Record<string, unknown>)?.events) ? (parsed.distribution as Record<string, unknown>).events as string[] : [], existingPrograms: Array.isArray((parsed.distribution as Record<string, unknown>)?.programs) ? (parsed.distribution as Record<string, unknown>).programs as string[] : [] },
    engineValueProps: Array.isArray(parsed.valueProps) ? parsed.valueProps : [],
    pitchAngles: Array.isArray(parsed.pitchAngles) ? parsed.pitchAngles : [],
    talkingPoints: Array.isArray(parsed.talkingPoints) ? parsed.talkingPoints : [],
    crossbeamSignals: cbSignals,
    recentNews: Array.isArray(parsed.recentNews) ? parsed.recentNews : [],
    engineAngle: String(parsed.engineAngle || ""),
  };
}

// ─── GET — poll for job status ────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });

  const job = await jobGet(jobId);
  if (!job) return NextResponse.json({ status: "processing" });

  if (job.status === "done") return NextResponse.json({ status: "done", brief: job.brief });
  if (job.status === "error") return NextResponse.json({ status: "error", error: job.error }, { status: 500 });
  return NextResponse.json({ status: "processing" });
}

// ─── POST — start research job ────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const { company, domain, notes, segmentFocus } = await req.json();
    if (!company?.trim()) return NextResponse.json({ error: "Company name required" }, { status: 400 });
    if (!KEY()) return NextResponse.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 });

    const jobId = crypto.randomUUID();
    await jobSet(jobId, "processing");

    after(async () => {
      try {
        const [rawBrief, ziData, cbSignals] = await Promise.all([
          researchAndSynthesize(company.trim(), domain?.trim() || "", notes?.trim() || "", segmentFocus || ""),
          enrichZoomInfo(company.trim()),
          checkCrossbeam(company.trim()),
        ]);

        const jsonMatch = rawBrief.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          await jobSet(jobId, "done", buildBrief({ fitScore: 0, fitTier: "Potential", fitSignals: [], snapshot: { name: company, description: rawBrief.slice(0, 200) } }, ziData, cbSignals, company, domain?.trim() || ""));
          return;
        }

        const parsed = JSON.parse(jsonMatch[0]);
        const brief = buildBrief(parsed, ziData, cbSignals, company, domain?.trim() || "");
        await jobSet(jobId, "done", brief);
      } catch (err) {
        await jobSet(jobId, "error", undefined, String(err));
      }
      cleanupMem();
    });

    return NextResponse.json({ jobId });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
