import { NextRequest } from "next/server";

// Node.js runtime — supports long-running fetch
export const maxDuration = 300;

const KEY = () => process.env.ANTHROPIC_API_KEY || "";

// ─── Build prompt ────────────────────────────────────────────────────────────

function buildPrompt(company: string, domain: string, notes: string, segmentFocus: string): string {
  const domainHint = domain ? ` (${domain})` : "";
  const smerfContext = `SMERF channel (Social · Military · Educational · Religious · Fraternal).
SMERF orgs: alumni associations, civic groups, veterans orgs, Greek life, faith-based orgs, unions, membership societies, school/university travel programs, nonprofit conferences, mission/retreat groups.
SMERF travel pattern: group room blocks for conventions, retreats, conferences, reunions, seminars, mission trips — consistent year-round including off-peak. Budget-conscious but loyal.`;
  const channelContext = segmentFocus && segmentFocus.toLowerCase() !== "smerf"
    ? `Rep's channel: ${segmentFocus}`
    : smerfContext;

  return `You are a senior partnerships analyst at Engine. Research "${company}"${domainHint} thoroughly and build a complete partner brief.

ENGINE CONTEXT:
Engine is a hotel booking platform for organizations. Partners earn 1% rev share on all bookings their members/employees make. Members save avg 22% vs rack rates. 3.5hr average hotel response time. Engine works best as an ongoing partnership — not a one-time deal.
${notes ? `\nREP NOTES (important context from the rep): ${notes}` : ""}
SEGMENT CONTEXT: ${channelContext}

Search: "${company}" overview members employees events conferences travel hotel partnerships programs 2025

From your research, extract SPECIFIC details:
— Actual event names and attendance numbers (not "runs large events" — say "hosts annual XYZ Conference, 3,000 attendees")
— Actual member/customer count or size indicator
— Named existing vendor/partner programs if any
— Real cities or regions they operate in
— Any specific travel patterns (crews on job sites, members at conferences, reps visiting chapters)
— Anything timely: leadership change, new program launch, funding, growth news

SCORING — evaluate all four Engine partner criteria:
1. REPEAT ENGAGEMENT: Does this org have ongoing trusted relationships with members/customers? (not transactional one-off)
2. HIGH TRAVEL VOLUME: Do their people travel regularly and consistently for work or gatherings?
3. REVENUE MOTIVATED: Would they actively promote Engine for rev share, OR use it to cut their own travel costs?
4. VALUE MULTIPLIER: Does Engine genuinely make their members more successful — not just a referral fee?

fitScore 0-100:
+20 member/constituent network (200+ people they actively serve)
+15 runs recurring group travel events (conferences, conventions, retreats, tournaments, seminars)
+15 SMERF match (Social/Military/Educational/Religious/Fraternal) OR Engine channel match (Sports, Construction, Transportation, Industrial, Weddings)
+15 travel is recurring and work/gathering-tied — not occasional
+10 existing vendor or partner program (shows they monetize relationships)
+10 national or multi-regional footprint
+5 strong value multiplier (Engine clearly helps their members succeed)
-15 purely consumer/retail with no member-serving or B2B model
-10 travel is occasional or one-off only
fitTier: Strong>=65, Potential>=35, Low<35

PITCH ANGLES — for each angle provide a specific opening line the rep could actually say or write. Make it reference something real you found.

TALKING POINTS — 4-6 specific, concrete points. Each should reference actual facts about this org (event name, member count, a recent news item). No generic bullets.

Return ONLY this JSON (no markdown, no explanation):
{"snapshot":{"name":"","industry":"","size":"","locations":"","description":"","website":""},"fitScore":0,"fitTier":"Potential","fitSignals":[],"distribution":{"networkType":"","networkSize":"","events":[],"programs":[]},"valueProps":[{"headline":"","bullets":[]}],"pitchAngles":[{"angle":"","why":"","openingLine":""}],"talkingPoints":[],"recentNews":[],"engineAngle":""}`;
}

// ─── Research using Anthropic API (non-streaming) ─────────────────────────────

async function doResearch(
  company: string, domain: string, notes: string, segmentFocus: string
): Promise<string> {
  const prompt = buildPrompt(company, domain, notes, segmentFocus);

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000); // 2-min hard abort
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": KEY(),
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "web-search-2025-03-05",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 5000,
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
          messages: [{ role: "user", content: prompt }],
        }),
      });
      clearTimeout(timeout);

      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
      }

      const data = await res.json();
      const textBlocks: string[] = (data.content || [])
        .filter((b: { type: string }) => b.type === "text")
        .map((b: { text: string }) => b.text);

      // Web search returns multiple blocks — find the one with the brief JSON
      const briefBlock = textBlocks.find(
        b => b.includes('"snapshot"') || b.includes('"fitScore"') || b.includes('"fitTier"')
      );
      return briefBlock ?? textBlocks[textBlocks.length - 1] ?? "";

    } catch (err) {
      clearTimeout(timeout);
      if (attempt === 1) throw err;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error("Max retries exceeded");
}

// ─── ZoomInfo enrichment (optional, fast) ────────────────────────────────────

async function enrichZoomInfo(company: string): Promise<Record<string, unknown> | null> {
  const mcpUrl = process.env.ZOOMINFO_MCP_URL;
  if (!mcpUrl) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": KEY(),
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "mcp-client-2025-04-04",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        mcp_servers: [{
          type: "url", url: mcpUrl, name: "zoominfo",
          ...(process.env.ZOOMINFO_MCP_API_KEY ? { authorization_token: process.env.ZOOMINFO_MCP_API_KEY } : {}),
        }],
        messages: [{ role: "user", content: `Use enrich_companies to look up "${company}". Return ONLY JSON: {name, industry, employeeCount, revenueRange, numberOfLocations, description, hqCity, hqState, website}` }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = (data.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

// ─── Crossbeam overlap (optional, fast) ──────────────────────────────────────

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
    return overlaps.slice(0, 3).map((uuid: string) => ({
      partnerName: partners.find(p => p.uuid === uuid)?.name || "Engine Partner",
      overlapType: "Account overlap — warm path available",
    }));
  } catch { return []; }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { company, domain, notes, segmentFocus } = await req.json();

  if (!company?.trim()) {
    return new Response(JSON.stringify({ error: "Company name required" }) + "\n",
      { headers: { "Content-Type": "application/x-ndjson" } });
  }
  if (!KEY()) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not set" }) + "\n",
      { headers: { "Content-Type": "application/x-ndjson" } });
  }

  try {
    // Run enrichment in parallel while research is running
    const ziPromise = enrichZoomInfo(company.trim());
    const cbPromise = checkCrossbeam(company.trim());
    const rawBrief = await doResearch(
      company.trim(), domain?.trim() || "", notes?.trim() || "", segmentFocus || ""
    );
    const [ziData, cbSignals] = await Promise.all([ziPromise, cbPromise]);

    // Parse the brief JSON from the collected text
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parsed: any = null;
    const jsonMatch = rawBrief.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch { /* will use fallback */ }
    }

    let brief;
    if (!parsed) {
      brief = {
        companySnapshot: { name: company, industry: "", size: "", locations: "", description: rawBrief.slice(0, 300), website: domain || "" },
        partnershipFit: { score: 0, tier: "Potential", signals: ["Research complete — see description"] },
        distributionPower: { networkSize: "Unknown", networkType: "Unknown", events: [], existingPrograms: [] },
        engineValueProps: [], pitchAngles: [], talkingPoints: [],
        crossbeamSignals: cbSignals, recentNews: [], engineAngle: rawBrief.slice(0, 500),
      };
    } else {
      const snapshot = {
        name: String(ziData?.name || parsed.snapshot?.name || company),
        industry: String(ziData?.industry || parsed.snapshot?.industry || ""),
        size: ziData?.employeeCount ? `${Number(ziData.employeeCount).toLocaleString()} employees` : String(parsed.snapshot?.size || ""),
        locations: ziData?.numberOfLocations ? `${ziData.numberOfLocations} locations` : String(parsed.snapshot?.locations || ""),
        description: String(ziData?.description || parsed.snapshot?.description || ""),
        website: String(ziData?.website || parsed.snapshot?.website || domain || ""),
      };
      brief = {
        companySnapshot: snapshot,
        partnershipFit: {
          score: Number(parsed.fitScore || 0),
          tier: (parsed.fitTier || "Potential") as "Strong" | "Potential" | "Low",
          signals: Array.isArray(parsed.fitSignals) ? parsed.fitSignals : [],
        },
        distributionPower: {
          networkSize: String(parsed.distribution?.networkSize || "Unknown"),
          networkType: String(parsed.distribution?.networkType || "Unknown"),
          events: Array.isArray(parsed.distribution?.events) ? parsed.distribution.events : [],
          existingPrograms: Array.isArray(parsed.distribution?.programs) ? parsed.distribution.programs : [],
        },
        engineValueProps: Array.isArray(parsed.valueProps) ? parsed.valueProps : [],
        pitchAngles: Array.isArray(parsed.pitchAngles) ? parsed.pitchAngles : [],
        talkingPoints: Array.isArray(parsed.talkingPoints) ? parsed.talkingPoints : [],
        crossbeamSignals: cbSignals,
        recentNews: Array.isArray(parsed.recentNews) ? parsed.recentNews : [],
        engineAngle: String(parsed.engineAngle || ""),
      };
    }

    // Return as NDJSON line (trailing \n is required by the client parser)
    return new Response(JSON.stringify({ brief }) + "\n", {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
      },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }) + "\n", {
      headers: { "Content-Type": "application/x-ndjson" },
    });
  }
}
