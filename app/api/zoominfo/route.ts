import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { orgName, orgType, orgContext } = await req.json();

  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1000,
    messages: [
      {
        role: "user",
        content: `Use ZoomInfo to search for decision-maker contacts at "${orgName}" which is a ${orgType}.
${orgContext ? "Context: " + orgContext : ""}
Find up to 3 contacts with titles like Executive Director, VP of Programs, Director of Events, or similar leadership roles.
Return their full name, title, company, and email address.
Format the response as JSON: {"contacts":[{"name":"Full Name","title":"Title","company":"${orgName}","email":"email@domain.com"}]}`,
      },
    ],
    mcp_servers: [
      { type: "url", url: "https://mcp.zoominfo.com/mcp", name: "zoominfo-mcp" },
    ],
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY || "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  const text = (data?.content || [])
    .filter((b: { type: string }) => b?.type === "text")
    .map((b: { text: string }) => b.text)
    .join("\n");

  return NextResponse.json({ text });
}
