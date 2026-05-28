/**
 * Temporary diagnostic endpoint — DELETE after debugging discovery cron issue.
 * GET /api/test-discovery
 * Runs the exact same Anthropic call as discoverOrgs and returns the raw result.
 */
import { NextResponse } from "next/server";

export const maxDuration = 60;

export async function GET() {
  const apiKey = process.env.ANTHROPIC_API_KEY || "";

  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 600,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
    messages: [{
      role: "user",
      content: `Find exactly 3 US fraternal organizations with national headquarters not in this list: American Legion, VFW, Rotary. Return ONLY valid JSON, no other text: {"orgs":[{"name":"Full Organization Name","type":"SMERF sub-category","website":"https://www.example.org"}]}`,
    }],
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "web-search-2025-03-05",
    },
    body: JSON.stringify(body),
  });

  const status = res.status;
  const rawText = await res.text();

  // Try to parse and extract text blocks
  let textBlocks: string[] = [];
  let stopReason = "";
  let jsonMatch = null;
  let orgsFound = 0;

  try {
    const data = JSON.parse(rawText);
    stopReason = data?.stop_reason || "";
    textBlocks = (data?.content || [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text);
    const fullText = textBlocks.join("\n");
    const match = fullText.match(/\{[\s\S]*"orgs"[\s\S]*\}/);
    if (match) {
      jsonMatch = match[0].slice(0, 200);
      const parsed = JSON.parse(match[0]);
      orgsFound = (parsed.orgs || []).length;
    }
  } catch { /* ignore */ }

  return NextResponse.json({
    apiKeyPresent: !!apiKey,
    apiKeyPrefix: apiKey.slice(0, 20),
    httpStatus: status,
    httpOk: res.ok,
    stopReason,
    textBlockCount: textBlocks.length,
    textPreview: textBlocks[0]?.slice(0, 300) || "",
    jsonMatch: jsonMatch,
    orgsFound,
    rawPreview: rawText.slice(0, 500),
  });
}
