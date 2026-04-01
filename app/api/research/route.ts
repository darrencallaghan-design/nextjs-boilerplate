import { NextRequest, NextResponse } from "next/server";

// Uses Claude's built-in web_search tool (Anthropic handles execution server-side).
// Claude searches the web and returns a final research summary in one API call.
export async function POST(req: NextRequest) {
  const { orgName, orgType, contactName, contactTitle, orgContext } = await req.json();

  const userMessage = `You are helping a business development rep at Engine.com (a B2B group travel platform) write a personalized outreach email.

Search the web for recent, specific information about this organization:

Organization: ${orgName} (${orgType})
Contact to email: ${contactName}, ${contactTitle}
${orgContext ? `Additional context: ${orgContext}` : ""}

Find:
1. Any upcoming or recent events/conferences they organize
2. Recent news, leadership changes, or announcements
3. Their scale (how many members, chapters, events per year)
4. Any travel-related challenges, RFPs, or initiatives

Then write 4-6 concise, specific research notes a sales rep can use to personalize an outreach email. Include real details from what you found. No generic filler. These notes go to the rep, not in the email itself.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY || "",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "web-search-2025-03-05",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok) {
    // Fall back gracefully — page.tsx will use the non-web-search research path
    return NextResponse.json({ text: "" }, { status: res.status });
  }

  const data = await res.json();
  const text = (data?.content || [])
    .filter((b: { type: string }) => b?.type === "text")
    .map((b: { text: string }) => b.text)
    .join("\n");

  return NextResponse.json({ text });
}
