/**
 * Discovery pipeline agent functions — shared between the daily cron, AI Search,
 * and chat. All Anthropic calls go through lib/anthropic.ts (callAnthropic) so
 * they get per-attempt timeouts, bounded retries, usage/cost logging to
 * agent_logs, and the daily spend cap.
 */

import { callAnthropic, textOf } from "./anthropic";

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

export interface DiscoveredContact {
  name: string; title: string; email: string; source: string; emailVerified: boolean;
}

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

  const result = await callAnthropic({
    route: "discovery:orgs",
    betas: ["web-search-2025-03-05"],
    attemptTimeoutMs: 60_000,
    maxAttempts: 2,
    totalBudgetMs: 110_000,
    body: {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
      messages: [{
        role: "user",
        content: `Search the web and find UP TO ${count} real US organizations that match this description:

${category}

Requirements:
- US-based national or regional organization
- Has professional paid staff (any executive-level title)
- Members or staff travel for events, conventions, or programs
${alreadyIn !== "none yet" ? `\nEXCLUDE these already-known orgs: ${alreadyIn}\n` : ""}
After searching, output ONLY this JSON (no prose, no explanation, no markdown):
{"orgs":[{"name":"Full Organization Name","type":"type of org","website":"https://..."}]}

If you found nothing, output: {"orgs":[]}`,
      }],
    },
  });

  if (!result.ok) {
    console.error(`[discovery] discoverOrgsWithCategory failed: ${result.error}`);
    return [];
  }
  const text = textOf(result.data);
  console.log(`[discovery] discoverOrgsWithCategory stop_reason=${result.data?.stop_reason} text_len=${text.length} preview=${JSON.stringify(text.slice(0, 300))}`);

  const jsonStr = extractOrgsJson(text);
  if (!jsonStr) {
    console.error("[discovery] discoverOrgsWithCategory: no orgs JSON found. stop_reason:", result.data?.stop_reason, "text:", text.slice(0, 500));
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
  const result = await callAnthropic({
    route: "discovery:research",
    betas: ["web-search-2025-03-05"],
    attemptTimeoutMs: 60_000,
    maxAttempts: 1,
    totalBudgetMs: 62_000,
    body: {
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
    },
  });
  if (!result.ok) return { research: "", website: "" };
  const text = textOf(result.data);
  const websiteMatch = text.match(/^WEBSITE:\s*(.+)$/im);
  const urlFallback = text.match(/https?:\/\/(?:www\.)?[a-zA-Z0-9-]+(?:\.[a-zA-Z]{2,})+/);
  const website = websiteMatch ? websiteMatch[1].trim().replace(/[.,)»"]+$/, "") : urlFallback ? urlFallback[0] : "";
  const research = text.replace(/^WEBSITE:\s*.+\n*/im, "").trim();
  return { research, website };
}

// ── Website Scraper subagent ──────────────────────────────────────────────────
export async function scrapeWebsiteContacts(website: string, orgName: string): Promise<DiscoveredContact[]> {
  if (!website) return [];
  const base = website.replace(/\/$/, "");
  const result = await callAnthropic({
    route: "discovery:scrape",
    betas: ["web-search-2025-03-05"],
    attemptTimeoutMs: 60_000,
    maxAttempts: 1,
    totalBudgetMs: 62_000,
    body: {
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
    },
  });
  if (!result.ok) return [];
  const text = textOf(result.data);
  const match = text.match(/\{[\s\S]*"contacts"[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return (parsed.contacts || []).filter((p: { name?: string; title?: string }) => p.name && p.title).slice(0, 4)
      .map((p: { name: string; title: string; email?: string }) => ({ name: p.name, title: p.title, email: p.email || "", source: "Website", emailVerified: !!(p.email) }));
  } catch { return []; }
}

// ── Contact Finder subagent ───────────────────────────────────────────────────
export async function findContacts(orgName: string, orgType: string, domain: string): Promise<DiscoveredContact[]> {
  const domainClean = (domain || "").replace(/https?:\/\//i, "").replace(/\/.*$/, "").trim();
  const result = await callAnthropic({
    route: "discovery:contacts",
    betas: ["web-search-2025-03-05"],
    attemptTimeoutMs: 60_000,
    maxAttempts: 1,
    totalBudgetMs: 62_000,
    body: {
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
    },
  });
  if (!result.ok) return [];
  const text = textOf(result.data);
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

// ── Email Miner subagent (pass 2) ─────────────────────────────────────────────
/**
 * Targeted second pass for contacts that came back without an email address.
 * Mirrors the proven /api/contacts pass-2 strategy: mine RocketReach snippets,
 * staff/contact pages, and press releases; extract the org's email format from
 * any known address and construct the rest. Uses Sonnet — email mining is the
 * step where the cheaper model demonstrably underperforms.
 *
 * Mutates the passed contacts in place (fills email/source/emailVerified) and
 * returns the same array. One batched call per org, only when needed.
 */
export async function mineMissingEmails(
  orgName: string, website: string, contacts: DiscoveredContact[],
): Promise<DiscoveredContact[]> {
  const domainClean = (website || "").replace(/https?:\/\//i, "").replace(/\/.*$/, "").trim();
  const needsEmail = contacts.filter(c => !c.email && c.source !== "Fallback");
  if (!needsEmail.length) return contacts;

  const hasEmail = contacts.filter(c => c.email);
  const knownPattern = hasEmail.length > 0
    ? `Known emails at this org: ${hasEmail.map(c => `${c.name} → ${c.email}`).join(", ")}. Extract the email format and apply it to the missing contacts.`
    : "";

  const result = await callAnthropic({
    route: "discovery:mine-emails",
    betas: ["web-search-2025-03-05"],
    attemptTimeoutMs: 75_000,
    maxAttempts: 1,
    totalBudgetMs: 77_000,
    body: {
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      messages: [{
        role: "user",
        content: `I need email addresses for these contacts at "${orgName}" (domain: ${domainClean || "unknown"}):
${needsEmail.map(c => `- ${c.name}, ${c.title}`).join("\n")}

${knownPattern}

SEARCH 1: ${domainClean ? `site:${domainClean}` : `"${orgName}" staff`} email OR contact OR mailto
${domainClean ? `Visit ${domainClean}/contact and ${domainClean}/staff for any email addresses shown.` : "Visit their website contact/staff page for emails."}

SEARCH 2: site:rocketreach.co ${needsEmail.map(c => `"${c.name}"`).join(" OR ")}
Read every snippet — full emails often appear in preview text without clicking through.

SEARCH 3: "${orgName}" email format ${domainClean ? `"@${domainClean}"` : "contact staff"}
Any email at their domain reveals the format for constructing others.

RULES:
- "found": the exact address appeared in a search result or on their site.
- "constructed": you built it from the org's known email format (e.g. first.last@domain). Only construct if you confirmed the format from at least one real address at this domain.
- If you can't find or confidently construct one, return an empty email for that person. Never guess a format you haven't seen.

Return ONLY valid JSON:
{"emails":[{"name":"Full Name","email":"address or empty","method":"found|constructed","source":"Website|RocketReach|Press|Pattern"}]}`,
      }],
    },
  });
  if (!result.ok) return contacts;
  const text = textOf(result.data);
  const match = text.match(/\{[\s\S]*"emails"[\s\S]*\}/);
  if (!match) return contacts;
  try {
    const parsed = JSON.parse(match[0]);
    const found: { name?: string; email?: string; method?: string; source?: string }[] = parsed.emails || [];
    for (const f of found) {
      if (!f.name || !f.email) continue;
      const target = contacts.find(c => c.name.toLowerCase().trim() === f.name!.toLowerCase().trim() && !c.email);
      if (!target) continue;
      target.email = f.email.trim();
      target.source = f.source || (f.method === "constructed" ? "Pattern" : "Web");
      target.emailVerified = f.method === "found";
    }
  } catch { /* keep originals */ }
  return contacts;
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
  const result = await callAnthropic({
    route: "discovery:draft",
    attemptTimeoutMs: 30_000,
    maxAttempts: Math.max(1, Math.min(retries, 3)),
    totalBudgetMs: 95_000,
    body: {
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
    },
  });
  if (!result.ok) return { subject: "", subjectB: "", body: "" };
  const raw = textOf(result.data);
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
