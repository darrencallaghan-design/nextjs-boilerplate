import { NextRequest, NextResponse } from "next/server";

// Pro plan: serverless, 90s — two full Sonnet passes, 12 searches total
export const maxDuration = 90;

async function callAnthropic(body: object, retries = 2): Promise<Response> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
      },
      body: JSON.stringify(body),
    });
    if (res.status !== 429) return res;
    await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
  }
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY || "",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "web-search-2025-03-05",
    },
    body: JSON.stringify(body),
  });
}

export async function POST(req: NextRequest) {
  const { orgName, orgType } = await req.json();

  // ── PASS 1: Find people + grab any emails visible in snippets (~20s) ──────────
  const pass1 = await callAnthropic({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
    messages: [{
      role: "user",
      content: `Find the 2-3 most senior decision-maker contacts at "${orgName}" (${orgType}) who would own vendor or partnership relationships.

Run these searches in order:

SEARCH 1: site:rocketreach.co "${orgName}"
READ EVERY SNIPPET carefully — RocketReach snippets frequently embed the full email address (e.g. cferrell@skillsusa.org) in the Google preview text without needing to click through. Extract every email address you can see in the snippets.

SEARCH 2: "${orgName}" staff team leadership site:.org OR site:.com
Visit the official website. Check /staff, /about, /team, /leadership, /people, /contact pages. Extract all names, titles, and any email addresses (mailto: links or @domain addresses).

SEARCH 3: site:projects.propublica.org/nonprofits "${orgName}"
990 filings list executive directors and officers. Note names and titles.

SEARCH 4: "${orgName}" executive director president CEO email contact
Look for emails in press releases, conference bios, speaker pages, news articles.

SEARCH 5: site:rocketreach.co "${orgName}" director president CEO
More RocketReach profiles — again read snippets for embedded emails.

Priority titles (in order): Executive Director, CEO, President, VP Partnerships, Director Business Development, VP Member Services, Director of Events, COO, Director of Operations.

Return ONLY valid JSON:
{"people":[{"name":"Full Name","title":"Exact Title","email":"found@email.com or empty string","domain":"orgdomain.org","source":"Website|RocketReach|Press Release|ProPublica|empty"}]}`
    }],
  });

  let people: { name: string; title: string; email: string; domain: string; source: string }[] = [];
  let confirmedDomain = "";

  if (pass1.ok) {
    const d1 = await pass1.json();
    const t1 = (d1?.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");
    const m1 = t1.match(/\{[\s\S]*"people"[\s\S]*\}/);
    if (m1) {
      try {
        const parsed = JSON.parse(m1[0]);
        people = (parsed.people || []).filter((p: { name?: string }) => p.name && p.name.trim() && p.name !== "Unknown").slice(0, 3);
        confirmedDomain = people.find(p => p.domain)?.domain || "";
      } catch { /* fall through */ }
    }
  }

  if (!people.length) return NextResponse.json({ contacts: [] });

  // ── PASS 2: Enrich missing emails — pattern mine + verify (~20s) ─────────────
  const needsEmail = people.filter(p => !p.email);
  const hasEmail = people.filter(p => p.email);

  if (needsEmail.length > 0) {
    const knownPattern = hasEmail.length > 0
      ? `Known emails at this org: ${hasEmail.map(p => `${p.name} → ${p.email}`).join(", ")}. Extract the email format and apply it to the missing contacts.`
      : "";

    const pass2 = await callAnthropic({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
      messages: [{
        role: "user",
        content: `I need email addresses for these contacts at "${orgName}" (domain: ${confirmedDomain || "unknown"}):
${needsEmail.map(p => `- ${p.name}, ${p.title}`).join("\n")}

${knownPattern}

Run these searches:

SEARCH 1: ${needsEmail.map(p => `"${p.name}" "${orgName}"`).join(" OR ")} email
Look for their emails in press releases, event pages, bios, news.

SEARCH 2: site:rocketreach.co ${needsEmail.map(p => `"${p.name}"`).join(" OR ")}
Read snippets — full emails often appear in the preview text.

SEARCH 3: "${orgName}" email format ${confirmedDomain ? `"@${confirmedDomain}"` : "contact staff"}
Find the org's email pattern. Any email at their domain reveals the format for all contacts.

SEARCH 4: ${needsEmail.map(p => `"${p.name}" email`).slice(0, 2).join(" OR ")} ${orgName}
Direct name searches in directories and professional sites.

SEARCH 5: site:zoominfo.com "${orgName}" ${needsEmail[0]?.name || ""}
ZoomInfo shows partial emails like "j***@org.com" — extract the first letter + domain to reconstruct.

EMAIL CONSTRUCTION RULES (apply after all searches):
${hasEmail.length > 0
  ? `You have confirmed emails: ${hasEmail.map(p => p.email).join(", ")}. Apply the EXACT same format (firstname.lastname@, flastname@, firstname@, etc.) to construct emails for the missing people.`
  : `If you find any email at this domain, extract the pattern and construct emails for all contacts. If no pattern found, use firstname.lastname@${confirmedDomain || `${orgName.toLowerCase().replace(/[^a-z0-9]/g, "")}.org`}`}

For constructed emails: emailVerified: false, source: "Pattern-${confirmedDomain || "domain"}"
For guessed with no domain found: emailVerified: false, source: "Predicted"
For found on a real page: emailVerified: true, source: "Website" or "RocketReach" or "Press Release"

VERIFICATION: For each email you construct, do a quick search for that exact email address in quotes. If it appears on any webpage, mark emailVerified: true, source: "Verified".

Return ONLY valid JSON:
{"enriched":[{"name":"Full Name","email":"email@domain.com","emailVerified":false,"source":"Pattern-domain.org"}]}`
      }],
    });

    if (pass2.ok) {
      const d2 = await pass2.json();
      const t2 = (d2?.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");
      const m2 = t2.match(/\{[\s\S]*"enriched"[\s\S]*\}/);
      if (m2) {
        try {
          const enriched: { name: string; email: string; emailVerified: boolean; source: string }[] = JSON.parse(m2[0]).enriched || [];
          people = people.map(person => {
            if (person.email) return person;
            const match = enriched.find(e =>
              e.name === person.name ||
              e.name?.toLowerCase().includes((person.name?.split(" ").pop() || "").toLowerCase())
            );
            return match ? { ...person, email: match.email || "", source: match.source || "Predicted", emailVerified: match.emailVerified } : person;
          });
        } catch { /* fall through */ }
      }
    }
  }

  const contacts = people.map(p => ({
    name: p.name,
    title: p.title,
    company: orgName,
    email: (p as { email?: string }).email || "",
    emailVerified: (p as { emailVerified?: boolean }).emailVerified ??
      (!!(p as { email?: string }).email &&
        !["Pattern", "Predicted"].some(s => ((p as { source?: string }).source || "").includes(s))),
    source: (p as { source?: string }).source || "",
  })).filter(c => c.name && c.name !== "Unknown");

  return NextResponse.json({ contacts });
}
