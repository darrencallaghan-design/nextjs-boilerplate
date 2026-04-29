import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

const KEY = () => process.env.ANTHROPIC_API_KEY || "";

async function researchAndSynthesize(company: string, domain: string, notes: string, segmentFocus: string): Promise<string> {
  const domainHint = domain ? ` (${domain})` : "";
  const smerfContext = `SMERF org (alumni, civic, veterans, Greek life, faith orgs, unions, membership societies, school travel, nonprofit conferences)`;
  const channelContext = segmentFocus && segmentFocus.toLowerCase() !== "smerf" ? `Channel focus: ${segmentFocus}` : smerfContext;

  // Engine partnership scoring rubric included inline
  const prompt = `Search for "${company}"${domainHint} then output a SINGLE LINE of minified JSON (no spaces, no newlines, no markdown, no explanation).

Engine=hotel booking platform for orgs, 1% rev share, 22% member hotel savings. ${channelContext}.${notes ? ` Rep notes: ${notes}` : ""}

Score 0-100: +20 member network 200+, +15 recurring travel events/conferences, +15 SMERF/channel match, +15 work-tied or member travel, +10 existing vendor/member benefits program, +10 national footprint, +5 mission-value fit. Deduct -15 consumer-only org, -10 only occasional travel. Strong>=65, Potential>=35, Low<35.

Use real specifics from search: actual event names, member counts, named programs, real cities. Strings max 15 words each.

Output ONLY this JSON minified on one line (fill in the empty strings and numbers with real data):
{"snapshot":{"name":"","industry":"","size":"","locations":"","description":"","website":""},"fitScore":0,"fitTier":"Potential","fitSignals":["s1","s2","s3"],"distribution":{"networkType":"","networkSize":"","events":["e1","e2"],"programs":["p1","p2"]},"valueProps":[{"headline":"","bullets":["b1","b2"]},{"headline":"","bullets":["b1","b2"]}],"pitchAngles":[{"angle":"","why":"","openingLine":""},{"angle":"","why":"","openingLine":""}],"talkingPoints":["t1","t2","t3","t4"],"recentNews":[{"headline":"","date":""}],"engineAngle":""}`;

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
          max_tokens: 1000,
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (res.status === 429) { await new Promise(r => setTimeout(r, 2000)); continue; }
      if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
      const data = await res.json();
      // Web search responses have multiple content blocks; find the text block with the JSON
      const blocks: { type: string; text?: string }[] = data.content || [];
      const textBlocks = blocks.filter(b => b.type === "text" && b.text);
      // Find the block containing the JSON brief (scan in reverse for the final text block)
      for (const block of [...textBlocks].reverse()) {
        const t = block.text || "";
        if (t.includes('"fitScore"') || t.includes('"snapshot"') || t.includes('"fitTier"')) {
          return t;
        }
      }
      // Fallback: return all text joined
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

export async function POST(req: NextRequest) {
  try {
    const { company, domain, notes, segmentFocus } = await req.json();
    if (!company?.trim()) return NextResponse.json({ error: "Company name required" }, { status: 400 });
    if (!KEY()) return NextResponse.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 });

    const [rawBrief, ziData, cbSignals] = await Promise.all([
      researchAndSynthesize(company.trim(), domain?.trim() || "", notes?.trim() || "", segmentFocus || ""),
      enrichZoomInfo(company.trim()),
      checkCrossbeam(company.trim()),
    ]);

    const jsonMatch = rawBrief.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json({ brief: { companySnapshot: { name: company, industry: "", size: "", locations: "", description: rawBrief.slice(0, 200), website: domain || "" }, partnershipFit: { score: 0, tier: "Potential" as const, signals: [] }, distributionPower: { networkSize: "Unknown", networkType: "Unknown", events: [], existingPrograms: [] }, engineValueProps: [], pitchAngles: [], talkingPoints: [], crossbeamSignals: cbSignals, recentNews: [], engineAngle: "" } });
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const snapshot = {
      name: String(ziData?.name || parsed.snapshot?.name || company),
      industry: String(ziData?.industry || parsed.snapshot?.industry || ""),
      size: ziData?.employeeCount ? `${Number(ziData.employeeCount).toLocaleString()} employees` : String(parsed.snapshot?.size || ""),
      locations: ziData?.numberOfLocations ? `${ziData.numberOfLocations} locations` : String(parsed.snapshot?.locations || ""),
      description: String(ziData?.description || parsed.snapshot?.description || ""),
      website: String(ziData?.website || parsed.snapshot?.website || domain || ""),
    };

    return NextResponse.json({ brief: { companySnapshot: snapshot, partnershipFit: { score: Number(parsed.fitScore || 0), tier: (parsed.fitTier || "Potential") as "Strong" | "Potential" | "Low", signals: Array.isArray(parsed.fitSignals) ? parsed.fitSignals : [] }, distributionPower: { networkSize: String(parsed.distribution?.networkSize || "Unknown"), networkType: String(parsed.distribution?.networkType || "Unknown"), events: Array.isArray(parsed.distribution?.events) ? parsed.distribution.events : [], existingPrograms: Array.isArray(parsed.distribution?.programs) ? parsed.distribution.programs : [] }, engineValueProps: Array.isArray(parsed.valueProps) ? parsed.valueProps : [], pitchAngles: Array.isArray(parsed.pitchAngles) ? parsed.pitchAngles : [], talkingPoints: Array.isArray(parsed.talkingPoints) ? parsed.talkingPoints : [], crossbeamSignals: cbSignals, recentNews: Array.isArray(parsed.recentNews) ? parsed.recentNews : [], engineAngle: String(parsed.engineAngle || "") } });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
