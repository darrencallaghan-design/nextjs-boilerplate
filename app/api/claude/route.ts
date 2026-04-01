import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { messages, mcpServers } = await req.json();

  const body: Record<string, unknown> = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages,
  };
  if (mcpServers && mcpServers.length > 0) body.mcp_servers = mcpServers;

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
