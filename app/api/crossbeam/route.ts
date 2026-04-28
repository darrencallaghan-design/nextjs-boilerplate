import { NextRequest, NextResponse } from "next/server";

const CB_BASE = "https://api.crossbeam.com/v0.2";

function getHeaders() {
  const key = process.env.CROSSBEAM_API_KEY || "";
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

// ── Fetch all partners (with names) ──────────────────────────────────────────
async function fetchPartners() {
  const res = await fetch(`${CB_BASE}/partners?limit=100`, {
    headers: getHeaders(),
    next: { revalidate: 300 }, // cache 5 min
  });
  if (!res.ok) throw new Error(`Crossbeam partners error: ${res.status}`);
  const data = await res.json();
  return (data.items || data.data || []) as {
    uuid: string;
    name: string;
    domain?: string;
    status?: string;
  }[];
}

// ── Partner leaderboard ──────────────────────────────────────────────────────
async function fetchLeaderboard(partners: { uuid: string; name: string }[]) {
  const res = await fetch(
    `${CB_BASE}/ecosystem-metrics/partner-leaderboard?limit=10&order=desc-nulls-last&start_date=${new Date().getFullYear()}-01`,
    { headers: getHeaders() }
  );
  if (!res.ok) throw new Error(`Crossbeam leaderboard error: ${res.status}`);
  const data = await res.json();
  const partnerMap = Object.fromEntries(partners.map((p) => [p.uuid, p.name]));

  return (data.items || []).map((item: {
    partner_uuid: string;
    coverage?: { overlaps_count?: number };
    engagement?: { activities_count?: number; opportunities_count?: number };
    partner_impact?: string;
    status?: { last_sync?: string; last_active?: string };
    attribution?: { amount_in_usd?: number };
  }) => ({
    name: partnerMap[item.partner_uuid] || "Unknown Partner",
    overlaps: item.coverage?.overlaps_count || 0,
    engagement: item.engagement?.activities_count || 0,
    impact: item.partner_impact || "unknown",
    lastSync: item.status?.last_sync || "unknown",
    lastActive: item.status?.last_active || "unknown",
    attribution: item.attribution?.amount_in_usd || 0,
  }));
}

// ── Account overlap lookup ────────────────────────────────────────────────────
// Uses Anthropic API with Crossbeam MCP (if configured) or REST API search
async function lookupAccountOverlap(
  companyName: string,
  partners: { uuid: string; name: string }[]
) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY || "";
  const cbMcpUrl = process.env.CROSSBEAM_MCP_URL || "";
  const cbMcpToken = process.env.CROSSBEAM_MCP_TOKEN || "";

  // ── Option A: Use Anthropic + Crossbeam MCP (most accurate) ──
  if (cbMcpUrl) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "mcp-client-2025-04-04",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 600,
          mcp_servers: [
            {
              type: "url",
              url: cbMcpUrl,
              name: "crossbeam",
              ...(cbMcpToken ? { authorization_token: cbMcpToken } : {}),
            },
          ],
          messages: [
            {
              role: "user",
              content: `Use get_account_overlap_info to look up "${companyName}". Return a JSON object with: overlappingPartners (array of partner names who have overlap), totalOverlaps (number), isCustomer (bool), isProspect (bool). Return ONLY valid JSON, nothing else. If no account found, return {"overlappingPartners":[],"totalOverlaps":0,"isCustomer":false,"isProspect":false}`,
            },
          ],
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const text = (data?.content || [])
          .filter((b: { type: string }) => b.type === "text")
          .map((b: { text: string }) => b.text)
          .join("");
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]);
      }
    } catch {
      // Fall through to REST API
    }
  }

  // ── Option B: REST API account search ──
  try {
    const encoded = encodeURIComponent(companyName);
    const res = await fetch(
      `${CB_BASE}/account-details?account_name=${encoded}`,
      { headers: getHeaders() }
    );
    if (res.ok) {
      const data = await res.json();
      const accounts = data.items || data.data || [];
      if (accounts.length > 0) {
        const account = accounts[0];
        const overlapPartnerIds: string[] = account.partner_overlaps?.map(
          (o: { partner_uuid: string }) => o.partner_uuid
        ) || [];
        const overlappingPartners = overlapPartnerIds
          .map((id) => partners.find((p) => p.uuid === id)?.name)
          .filter(Boolean) as string[];
        return {
          overlappingPartners,
          totalOverlaps: overlapPartnerIds.length,
          isCustomer: account.is_customer || false,
          isProspect: account.is_prospect || true,
        };
      }
    }
  } catch {
    // ignore — return empty result
  }

  return { overlappingPartners: [], totalOverlaps: 0, isCustomer: false, isProspect: false };
}

// ── Partner suggestions ───────────────────────────────────────────────────────
async function fetchSuggestions() {
  const res = await fetch(`${CB_BASE}/partner-suggestions?limit=8`, {
    headers: getHeaders(),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.items || data.data || []) as {
    name: string;
    domain: string;
    invite_url?: string;
  }[];
}

// ── Route handler ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const cbKey = process.env.CROSSBEAM_API_KEY || "";
  if (!cbKey) {
    return NextResponse.json({ error: "CROSSBEAM_API_KEY not configured", setup: true }, { status: 503 });
  }

  try {
    const { action, query } = await req.json();

    // Fetch partners first (needed for name mapping)
    const partners = await fetchPartners().catch(() => [] as { uuid: string; name: string; domain?: string; status?: string }[]);

    if (action === "partners") {
      return NextResponse.json({ partners });
    }

    if (action === "leaderboard") {
      const leaderboard = await fetchLeaderboard(partners);
      return NextResponse.json({ leaderboard });
    }

    if (action === "overlap" && query) {
      const overlap = await lookupAccountOverlap(query, partners);
      return NextResponse.json({ overlap });
    }

    if (action === "suggestions") {
      const suggestions = await fetchSuggestions();
      return NextResponse.json({ suggestions });
    }

    if (action === "dashboard") {
      // Return everything needed for the Partners panel in one call
      const [leaderboard, suggestions] = await Promise.all([
        fetchLeaderboard(partners).catch(() => []),
        fetchSuggestions().catch(() => []),
      ]);
      return NextResponse.json({ partners, leaderboard, suggestions });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    console.error("Crossbeam API error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
