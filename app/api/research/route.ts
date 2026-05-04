import { NextRequest, NextResponse } from "next/server";

// claude-sonnet with web search can take 2-3 min; bumped to match partner-research
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const { orgName, orgType, contactName, contactTitle, orgContext } = await req.json();

  const userMessage = `You are helping a partnerships rep at Engine write a personalized outreach email. Engine is a hotel booking platform that works with membership organizations and associations as partners — not just selling hotel bookings, but creating ongoing partnerships where Engine becomes a value-add for the org's members or customers.

Search the web for specific, current information about this organization:

Organization: ${orgName} (${orgType})
Contact: ${contactName}, ${contactTitle}
${orgContext ? `Additional context: ${orgContext}` : ""}

Start your response with this line (required):
WEBSITE: [the org's primary website URL, e.g. https://www.example.org]

Then find and report on:
1. What events, conferences, or gatherings does ${orgName} run, and at what scale? (How many attendees, how often, which cities?)
2. How do they engage with members or customers on an ongoing basis? (Annual events, chapter meetings, benefits programs, certification programs?)
3. Do their members or customers have meaningful hotel travel tied to their work or participation?
4. Any recent news, new programs, leadership changes, or growth that makes this a timely moment to reach out?
5. What would make this org a good or bad fit as an Engine partner?

Write 6-8 specific, factual research notes using real details you found. Be precise — name actual events, actual attendance numbers, actual cities, actual programs. No generic filler. Each note should contain at least one concrete fact the rep can reference in their outreach email.`;

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
      max_tokens: 3000,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok) {
    return NextResponse.json({ text: "" }, { status: res.status });
  }

  const data = await res.json();
  const text = (data?.content || [])
    .filter((b: { type: string }) => b?.type === "text")
    .map((b: { text: string }) => b.text)
    .join("\n");

  // Extract the WEBSITE: line Claude was asked to output first
  const websiteMatch = text.match(/^WEBSITE:\s*(.+)$/im);
  const website = websiteMatch ? websiteMatch[1].trim().replace(/[.,)»"]+$/, "") : "";
  // Strip the WEBSITE: line from research text so it doesn't appear in email context
  const cleanText = text.replace(/^WEBSITE:\s*.+\n*/im, "").trim();

  return NextResponse.json({ text: cleanText, website });
}
