import { NextRequest, NextResponse } from "next/server";

// Pro plan: serverless, 90s
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
  const { orgName, orgType, domain } = await req.json();

  const domainClean = (domain || "").replace(/https?:\/\//i, "").replace(/\/.*$/, "").trim();

  // ── PASS 1: Find real people from the website first, then other sources ────────
  const websiteSearches = domainClean ? `
SEARCH 1 (MOST IMPORTANT): site:${domainClean}
Visit the website directly. Check these specific pages in order:
- ${domainClean}/staff
- ${domainClean}/our-staff
- ${domainClean}/team
- ${domainClean}/leadership
- ${domainClean}/about
- ${domainClean}/people
- ${domainClean}/contact
Extract EVERY person's name, title, and email address you find. People listed here are CONFIRMED current staff. Prefer these over any other source.

SEARCH 2: site:rocketreach.co "${orgName}"
Read EVERY snippet carefully — full email addresses (e.g. jsmith@org.com) are often embedded in the preview text without clicking through.

SEARCH 3: "${orgName}" "${domainClean}" staff email contact director
Find any emails in press releases, bios, or news articles.

SEARCH 4: site:projects.propublica.org/nonprofits "${orgName}"
990 filings list executive directors and officers with names and titles.

CRITICAL RULE: Only return people who are CONFIRMED to be at this org right now. People found on ${domainClean} directly are most reliable. Do NOT return people found only in old articles from 3+ years ago unless confirmed still there.`
  : `
SEARCH 1: "${orgName}" staff team leadership official website
Visit the official website. Check /staff, /about, /team, /leadership, /people pages. Extract all names, titles, and emails (mailto: links or @domain addresses).

SEARCH 2: site:rocketreach.co "${orgName}"
Read EVERY snippet carefully — full email addresses often appear in preview text.

SEARCH 3: site:projects.propublica.org/nonprofits "${orgName}"
990 filings list executive directors and officers.

SEARCH 4: "${orgName}" executive director president CEO email contact
Look for emails in press releases, conference bios, speaker pages.`;

  const pass1 = await callAnthropic({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
    messages: [{
      role: "user",
      content: `Find the 2-3 most senior decision-maker contacts at "${orgName}" (${orgType || "organization"}) who would own vendor or partnership relationships.
${domainClean ? `\nThe organization's website is: ${domainClean} — START HERE. People on the website are ground truth.` : ""}

${websiteSearches}

Priority titles (in order): Executive Director, CEO, President, VP Partnerships, Director Business Development, VP Member Services, Director of Events, COO, Director of Operations.

Return ONLY valid JSON — do not include anyone with name "Unknown":
{"people":[{"name":"Full Name","title":"Exact Title","email":"found@email.com or empty string","domain":"${domainClean || "orgdomain.org"}","source":"Website|RocketReach|Press Release|ProPublica"}]}`
    }],
  });

  let people: { name: string; title: string; email: string; domain: string; source: string }[] = [];
  let confirmedDomain = domainClean;

  if (pass1.ok) {
    const d1 = await pass1.json();
    const t1 = (d1?.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");
    const m1 = t1.match(/\{[\s\S]*"people"[\s\S]*\}/);
    if (m1) {
      try {
        const parsed = JSON.parse(m1[0]);
        people = (parsed.people || []).filter((p: { name?: string }) => p.name && p.name.trim() && p.name !== "Unknown").slice(0, 3);
        if (!confirmedDomain) confirmedDomain = people.find(p => p.domain)?.domain || "";
      } catch { /* fall through */ }
    }
  }

  if (!people.length) return NextResponse.json({ contacts: [] });

  // ── PASS 2: Enrich missing emails — pattern mine + verify ─────────────────────
  const needsEmail = people.filter(p => !p.email);
  const hasEmail = people.filter(p => p.email);

  if (needsEmail.length > 0) {
    const knownPattern = hasEmail.length > 0
      ? `Known emails at this org: ${hasEmail.map(p => `${p.name} → ${p.email}`).join(", ")}. Extract the email format and apply it to the missing contacts.`
      : "";

    const pass2 = await callAnthropic({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      messages: [{
        role: "user",
        content: `I need email addresses for these contacts at "${orgName}" (domain: ${confirmedDomain || "unknown"}):
${needsEmail.map(p => `- ${p.name}, ${p.title}`).join("\n")}

${knownPattern}

SEARCH 1: ${domainClean ? `site:${domainClean}` : `"${orgName}" staff`} email OR contact OR mailto
${domainClean ? `Directly visit ${domainClean}/contact, ${domainClean}/staff to find any email addresses shown.` : "Visit their website contact/staff page for emails."}

SEARCH 2: site:rocketreach.co ${needsEmail.map(p => `"${p.name}"`).join(" OR ")}
Read snippets — full emails often appear in preview text.

SEARCH 3: "${orgName}" email format ${confirmedDomain ? `"@${confirmedDomain}"` : "contact staff"}
Any email at their domain reveals the format for constructing others.

EMAIL CONSTRUCTION RULES:
${hasEmail.length > 0
  ? `You have confirmed emails: ${hasEmail.map(p => p.email).join(", ")}. Apply the EXACT same format (firstname.lastname@, flastname@, firstname@, etc.) to construct emails for the missing people.`
  : `If you find any email at this domain, extract the pattern and apply it. If nothing found, use firstname.lastname@${confirmedDomain || `${orgName.toLowerCase().replace(/[^a-z0-9]/g, "")}.org`}`}

- emailVerified: true ONLY if the email was actually found on a real webpage
- emailVerified: false for any email you constructed or guessed
- source: "Website" if found on their site, "RocketReach" if from there, "Pattern-domain" if constructed

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
