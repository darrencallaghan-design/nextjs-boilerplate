/**
 * Discovery pipeline agent functions — shared between the daily cron and AI Search.
 *
 * Extracted from app/api/cron/discovery/route.ts so both callers can import
 * the same logic without duplication.
 */

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Rotate SMERF sub-categories by day of week for pipeline diversity.
// All categories should have high travel volumes and many national orgs.
// K-12 removed — most districts aren't national orgs with paid executive staff.
export const SMERF_CATEGORIES = [
  "Greek-letter fraternities and sororities (NPC, IFC, NPHC, NALFO) with national headquarters and annual conventions",
  "alumni associations, honor societies, and reunion travel programs with national conventions",
  "veterans and military support organizations (American Legion, VFW, AMVETS, MOAA, etc.) with annual conferences",
  "religious denominations, faith-based nonprofits, and church networks with annual conferences or pilgrimages",
  "civic and community service organizations with national chapters (Lions, Rotary, Elks, Kiwanis, Knights of Columbus, Shriners, Moose Lodge)",
  "professional societies, medical associations, and trade associations with annual member conferences",
  "historically Black colleges (HBCU) alumni associations, BGLOs, and cultural heritage organizations with national reunions",
];

// Fallback categories — used when the primary yields nothing.
export const FALLBACK_CATEGORIES = [
  "genealogical and heritage societies, ethnic cultural associations, and ancestry clubs with national conventions",
  "sports hall of fame associations, interscholastic athletics federations, and amateur sports governing bodies with annual gatherings",
  "hobby, collectibles, and enthusiast clubs with national conventions (numismatics, philately, model railroads, antiques)",
  "performing arts organizations, bands, choral groups, and competitive dance associations with national competitions",
  "law enforcement, firefighter, and first responder associations with national fraternal chapters and annual conferences",
  "disability advocacy and rehabilitation networks, health condition support organizations with national conventions",
  "agricultural, farming, and rural cooperative associations with national annual meetings and member travel",
];

/** Extract the first complete JSON object containing "orgs" using brace counting.
 *  More reliable than a greedy regex when Claude surrounds the JSON with prose or
 *  outputs multiple JSON-like fragments.
 */
export function extractOrgsJson(text: string): string | null {
  // 1) Direct parse — fastest path when Claude obeys the JSON-only instruction
  try {
    const t = text.trim();
    const direct = JSON.parse(t);
    if (Array.isArray(direct?.orgs)) return t;
  } catch {}

  // 2) Find the LAST complete {"orgs"… } block (Claude sometimes outputs a draft
  //    then a corrected version — we want the final one)
  let lastGood: string | null = null;
  let searchFrom = 0;
  while (true) {
    const start = text.indexOf('{"orgs"', searchFrom);
    if (start === -1) break;
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) break; // unclosed — stop searching
    const candidate = text.slice(start, end + 1);
    try {
      const p = JSON.parse(candidate);
      if (Array.isArray(p?.orgs)) lastGood = candidate;
    } catch {}
    searchFrom = end + 1;
  }
  return lastGood;
}

// ── Discovery Agent — find new SMERF orgs ────────────────────────────────────
export async function discoverOrgsWithCategory(
  category: string,
  existingOrgs: string[],
  count: number,
): Promise<{ name: string; type: string; website: string }[]> {
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
      max_tokens: 1500,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
      messages: [{
        role: "user",
        content: `You are a research assistant. Find UP TO ${count} US SMERF organizations suitable for hotel partnership outreach. SMERF = Social, Military, Educational, Religious, Fraternal.

Today's category focus: ${category}

Requirements:
- US-based national or regional organization
- Has paid professional staff (any executive-level title)
- Members or staff travel for events, conventions, or programs
- NOT already in pipeline below

ALREADY IN PIPELINE — exclude these: ${alreadyIn}

MANDATORY RULES:
1. You MUST respond with ONLY valid JSON — no explanations, no prose, no refusals
2. Return however many you found (0 to ${count}) — fewer is fine if the category is narrow
3. If you found nothing, return: {"orgs":[]}
4. Do not explain why you could or couldn't find orgs — just return the JSON

Your ENTIRE response must be this exact JSON structure:
{"orgs":[{"name":"Full Organization Name","type":"SMERF sub-category","website":"https://www.example.org"}]}`,
      }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(`[discovery] discoverOrgsWithCategory API error ${res.status}: ${errBody.slice(0, 300)}`);
    return [];
  }
  const data = await res.json();
  const text = (data?.content || [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("\n");

  console.log(`[discovery] discoverOrgsWithCategory stop_reason=${data?.stop_reason} text_len=${text.length} preview=${JSON.stringify(text.slice(0, 300))}`);

  const jsonStr = extractOrgsJson(text);
  if (!jsonStr) {
    console.error("[discovery] discoverOrgsWithCategory: no orgs JSON found. stop_reason:", data?.stop_reason, "text:", text.slice(0, 500));
    return [];
  }
  try {
    const parsed = JSON.parse(jsonStr);
    const orgs = (parsed.orgs || []).filter((o: { name?: string }) => o.name).slice(0, count);
    console.log(`[discovery] discoverOrgsWithCategory found ${orgs.length} orgs`);
    return orgs;
  } catch (e) {
    console.error("[discovery] discoverOrgsWithCategory JSON parse error:", e, "jsonStr:", jsonStr.slice(0, 300));
    return [];
  }
}

// ── Research subagent ─────────────────────────────────────────────────────────
export async function researchOrg(orgName: string, orgType: string): Promise<{ research: string; website: string }> {
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
export async function scrapeWebsiteContacts(website: string, orgName: string): Promise<{ name: string; title: string; email: string; source: string; emailVerified: boolean }[]> {
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
export async function findContacts(orgName: string, orgType: string, domain: string): Promise<{ name: string; title: string; email: string; source: string; emailVerified: boolean }[]> {
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

export function stripDashes(t: string): string {
  return t.replace(/ [—–] /g, ", ").replace(/[—–] /g, "").replace(/ [—–]/g, "").replace(/[—–]/g, ", ");
}

// ── Draft email subagent ──────────────────────────────────────────────────────
export async function draftEmail(
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
RULES: No em dashes. No generic openers. Short soft ask at end. No markdown, no bold, no asterisks anywhere.

Output format — use EXACTLY this, plain text only:
SUBJECT_A: [curiosity/question style, org-specific]
SUBJECT_B: [value/direct style, leads with the benefit]

[email body]`,
        }],
      }),
    });
    if (res.status === 429) { await sleep(4000 * (i + 1)); continue; }
    if (!res.ok) return { subject: "", subjectB: "", body: "" };
    const data = await res.json();
    const raw = (data?.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");
    // Handle both plain "SUBJECT_A: ..." and markdown bold "**SUBJECT_A:** ..."
    const aMatch = raw.match(/^\*{0,2}SUBJECT[_ ]A:\*{0,2}\s*(.+)$/im);
    const bMatch = raw.match(/^\*{0,2}SUBJECT[_ ]B:\*{0,2}\s*(.+)$/im);
    const body = raw.replace(/^\*{0,2}SUBJECT[_ ][AB]:\*{0,2}\s*.+\n*/gim, "").replace(/^---\s*\n*/gm, "").trim();
    return {
      subject: aMatch ? stripDashes(aMatch[1].trim()) : `${orgName} + Engine`,
      subjectB: bMatch ? stripDashes(bMatch[1].trim()) : "",
      body: stripDashes(body),
    };
  }
  return { subject: "", subjectB: "", body: "" };
}
