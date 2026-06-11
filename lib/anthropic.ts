import { createClient } from "@supabase/supabase-js";

// ─── agent_logs table — run once in Supabase SQL editor: ────────────────────
//
// CREATE TABLE IF NOT EXISTS agent_logs (
//   id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
//   route         TEXT        NOT NULL,
//   model         TEXT        NOT NULL DEFAULT '',
//   status        TEXT        NOT NULL,
//   duration_ms   INTEGER     NOT NULL DEFAULT 0,
//   input_tokens  INTEGER     NOT NULL DEFAULT 0,
//   output_tokens INTEGER     NOT NULL DEFAULT 0,
//   web_searches  INTEGER     NOT NULL DEFAULT 0,
//   est_cost_usd  NUMERIC(10,4) NOT NULL DEFAULT 0,
//   error         TEXT        NOT NULL DEFAULT '',
//   created_at    TIMESTAMPTZ DEFAULT NOW()
// );
// CREATE INDEX IF NOT EXISTS agent_logs_created_at_idx ON agent_logs (created_at);
// ALTER TABLE agent_logs ENABLE ROW LEVEL SECURITY;
// CREATE POLICY "allow_all" ON agent_logs FOR ALL USING (true) WITH CHECK (true);

const supabase = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

// $ per 1M tokens. Update if models change.
const PRICE_PER_M: Record<string, { in: number; out: number }> = {
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
};
const WEB_SEARCH_COST_USD = 0.01; // $10 per 1,000 searches

// Daily ceiling across ALL routes. Override with env var.
const DAILY_SPEND_CAP_USD = Number(process.env.SCOUT_DAILY_SPEND_CAP_USD || "25");

export interface AnthropicCallOptions {
  /** Route name for logging, e.g. "partner-research" */
  route: string;
  /** Raw /v1/messages request body (model, max_tokens, messages, tools...) */
  body: Record<string, unknown>;
  /** Extra anthropic-beta header values */
  betas?: string[];
  /** Per-attempt abort timeout. Default 90s. */
  attemptTimeoutMs?: number;
  /** Max attempts including the first. Default 2. */
  maxAttempts?: number;
  /**
   * Hard wall-clock budget across ALL attempts + backoff. MUST be set
   * comfortably below the route's maxDuration, otherwise Vercel kills the
   * function mid-retry and the client sees a connection drop (HTTP 000).
   * Default 240s (fits maxDuration 300).
   */
  totalBudgetMs?: number;
}

export interface AnthropicCallResult {
  ok: boolean;
  status: number; // 0 = never got an HTTP response (timeout/network)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any | null; // parsed /v1/messages response when ok
  error: string;
  durationMs: number;
}

/** Joined text content blocks from a /v1/messages response. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function textOf(data: any): string {
  return (data?.content || [])
    .filter((b: { type: string }) => b?.type === "text")
    .map((b: { text: string }) => b.text)
    .join("\n");
}

/** Sum of today's estimated spend (UTC day) from agent_logs. */
export async function todaySpendUSD(): Promise<number> {
  try {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const { data, error } = await supabase()
      .from("agent_logs")
      .select("est_cost_usd")
      .gte("created_at", dayStart.toISOString());
    if (error || !data) return 0;
    return data.reduce((s, r) => s + Number(r.est_cost_usd || 0), 0);
  } catch {
    return 0; // fail-open: a broken logs table must not brick the app
  }
}

async function log(row: {
  route: string; model: string; status: string; duration_ms: number;
  input_tokens?: number; output_tokens?: number; web_searches?: number;
  est_cost_usd?: number; error?: string;
}) {
  try {
    await supabase().from("agent_logs").insert({
      input_tokens: 0, output_tokens: 0, web_searches: 0, est_cost_usd: 0, error: "",
      ...row,
    });
  } catch { /* never let logging break the route */ }
}

/**
 * Single entry point for all Anthropic /v1/messages calls.
 * Guarantees: per-attempt abort, bounded retries that respect a total
 * deadline, usage + cost logging to agent_logs, daily spend cap.
 */
export async function callAnthropic(opts: AnthropicCallOptions): Promise<AnthropicCallResult> {
  const {
    route, body, betas = [],
    attemptTimeoutMs = 90_000,
    maxAttempts = 2,
    totalBudgetMs = 240_000,
  } = opts;
  const model = String(body.model || "");
  const started = Date.now();
  const deadline = started + totalBudgetMs;

  // Spend cap — checked once per call, before spending anything.
  const spent = await todaySpendUSD();
  if (spent >= DAILY_SPEND_CAP_USD) {
    const error = `Daily spend cap reached ($${spent.toFixed(2)} >= $${DAILY_SPEND_CAP_USD}). Raise SCOUT_DAILY_SPEND_CAP_USD or wait until tomorrow (UTC).`;
    await log({ route, model, status: "budget_exceeded", duration_ms: 0, error });
    return { ok: false, status: 402, data: null, error, durationMs: 0 };
  }

  let lastError = "";
  let lastStatus = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 5_000) break; // not enough budget for another attempt

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(attemptTimeoutMs, remaining)
    );

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY || "",
          "anthropic-version": "2023-06-01",
          ...(betas.length ? { "anthropic-beta": betas.join(",") } : {}),
        },
        body: JSON.stringify(body),
      });
      clearTimeout(timer);
      lastStatus = res.status;

      if (res.status === 429 || res.status >= 500) {
        lastError = `Anthropic ${res.status}`;
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        const durationMs = Date.now() - started;
        const error = `Anthropic ${res.status}: ${text.slice(0, 300)}`;
        await log({ route, model, status: "error", duration_ms: durationMs, error });
        return { ok: false, status: res.status, data: null, error, durationMs };
      }

      const data = await res.json();
      const durationMs = Date.now() - started;
      const inTok = Number(data?.usage?.input_tokens || 0);
      const outTok = Number(data?.usage?.output_tokens || 0);
      const searches = Number(data?.usage?.server_tool_use?.web_search_requests || 0);
      const price = PRICE_PER_M[model] || { in: 3, out: 15 };
      const cost =
        (inTok / 1_000_000) * price.in +
        (outTok / 1_000_000) * price.out +
        searches * WEB_SEARCH_COST_USD;
      await log({
        route, model, status: "ok", duration_ms: durationMs,
        input_tokens: inTok, output_tokens: outTok,
        web_searches: searches, est_cost_usd: Number(cost.toFixed(4)),
      });
      return { ok: true, status: res.status, data, error: "", durationMs };

    } catch (err) {
      clearTimeout(timer);
      lastStatus = 0;
      lastError = controller.signal.aborted
        ? `Attempt timed out after ${Math.min(attemptTimeoutMs, remaining)}ms`
        : String(err);
    }
  }

  const durationMs = Date.now() - started;
  await log({
    route, model,
    status: lastStatus === 0 ? "timeout" : "error",
    duration_ms: durationMs, error: lastError,
  });
  return { ok: false, status: lastStatus, data: null, error: lastError || "Max retries exceeded", durationMs };
}
