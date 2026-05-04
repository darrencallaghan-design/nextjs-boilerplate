/**
 * Orchestrator Agent — parallel batch outreach
 *
 * POST /api/orchestrate
 *   Body: { orgs, styleContext, repName, wave }
 *   Returns: { runId, total }
 *   Immediately returns a runId, kicks off N parallel org workers via after()
 *
 * GET /api/orchestrate?runId=xxx
 *   Returns: { status, total, completed, failed, tasks: CompletedTask[] }
 *
 * Supabase tables required (run once in SQL editor):
 *
 * create table if not exists agent_runs (
 *   id text primary key,
 *   type text default 'batch_outreach',
 *   status text default 'running',
 *   total_tasks integer default 0,
 *   completed_tasks integer default 0,
 *   failed_tasks integer default 0,
 *   created_at timestamptz default now()
 * );
 * alter table agent_runs enable row level security;
 * create policy "allow_all" on agent_runs for all using (true) with check (true);
 *
 * create table if not exists agent_tasks (
 *   id text primary key,
 *   run_id text,
 *   org_name text,
 *   status text default 'pending',
 *   result jsonb,
 *   error text,
 *   created_at timestamptz default now()
 * );
 * alter table agent_tasks enable row level security;
 * create policy "allow_all" on agent_tasks for all using (true) with check (true);
 */

import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const maxDuration = 300;

// ── Supabase ──────────────────────────────────────────────────────────────────
function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface OrgContact {
  name: string;
  title: string;
  company: string;
  email: string;
  source?: string;
  emailVerified?: boolean;
}
interface InputOrg {
  name: string;
  type: string;
  contacts: OrgContact[];
}
interface DraftResult {
  contact: OrgContact;
  subject: string;
  subjectB?: string;
  body: string;
}
interface TaskResult {
  orgName: string;
  orgType: string;
  drafts: DraftResult[];
  research: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function stripDashes(t: string): string {
  return t
    .replace(/ [—–] /g, ", ")
    .replace(/[—–] /g, "")
    .replace(/ [—–]/g, "")
    .replace(/[—–]/g, ", ");
}

function parseDraft(raw: string): { subject: string; subjectB?: string; body: string } {
  const aMatch = raw.match(/^SUBJECT[_ ]A:\s*(.+)$/im);
  const bMatch = raw.match(/^SUBJECT[_ ]B:\s*(.+)$/im);
  if (aMatch) {
    const body = raw.replace(/^SUBJECT[_ ][AB]:\s*.+\n*/gim, "").trim();
    return {
      subject: stripDashes(aMatch[1].trim()),
      subjectB: bMatch ? stripDashes(bMatch[1].trim()) : undefined,
      body: stripDashes(body),
    };
  }
  const sMatch = raw.match(/^SUBJECT:\s*(.+)$/im);
  if (sMatch) {
    return {
      subject: stripDashes(sMatch[1].trim()),
      body: stripDashes(raw.replace(/^SUBJECT:\s*.+\n*/im, "").trim()),
    };
  }
  const lines = raw.trim().split("\n");
  return {
    subject: stripDashes(lines[0] || ""),
    body: stripDashes(lines.slice(1).join("\n").trim()),
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── AI calls ──────────────────────────────────────────────────────────────────
async function callClaude(
  messages: { role: string; content: string }[],
  model = "claude-haiku-4-5-20251001",
  maxTokens = 1200,
  retries = 3
): Promise<string> {
  for (let i = 0; i < retries; i++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
    });
    if (res.status === 429) { await sleep(4000 * (i + 1)); continue; }
    if (!res.ok) return "";
    const data = await res.json();
    return (data?.content || [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("\n");
  }
  return "";
}

// ── Contact Finder subagent ───────────────────────────────────────────────────
async function findContacts(orgName: string, orgType: string, domain: string): Promise<OrgContact[]> {
  const domainClean = (domain || "").replace(/https?:\/\//i, "").replace(/\/.*$/, "").trim();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY || "",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "web-search-2025-03-05",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      messages: [{
        role: "user",
        content: `Find the 2-3 most senior decision-makers at "${orgName}" (${orgType}) who would own vendor or partnership decisions.${domainClean ? ` Website: ${domainClean} — check /staff, /leadership, /about first.` : ""}
Search: site:rocketreach.co "${orgName}" and "${orgName}" executive director president email.
Priority titles: Executive Director, CEO, President, VP Partnerships, Director Business Development, COO.
Return ONLY valid JSON: {"people":[{"name":"Full Name","title":"Exact Title","email":"email@domain.com or empty","source":"Website|RocketReach|Predicted"}]}`,
      }],
    }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  const text = (data?.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");
  const match = text.match(/\{[\s\S]*"people"[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return (parsed.people || [])
      .filter((p: { name?: string }) => p.name && p.name !== "Unknown")
      .slice(0, 3)
      .map((p: { name: string; title: string; email?: string; source?: string }) => ({
        name: p.name,
        title: p.title || "Director",
        company: orgName,
        email: p.email || "",
        source: p.source || "Web",
        emailVerified: !!(p.email && !["Pattern", "Predicted"].some(s => (p.source || "").includes(s))),
      }));
  } catch { return []; }
}

// ── Researcher subagent ───────────────────────────────────────────────────────
async function researchOrg(orgName: string, orgType: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY || "",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "web-search-2025-03-05",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
      messages: [{
        role: "user",
        content: `Research "${orgName}" (${orgType}) for a hotel partnership pitch. Find: events they run (names, attendance, cities), member/network size, travel patterns, recent news. Return 4-5 specific facts with real numbers. Concise.`,
      }],
    }),
  });
  if (!res.ok) return "";
  const data = await res.json();
  return (data?.content || [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("\n");
}

// ── Copywriter subagent ───────────────────────────────────────────────────────
async function draftEmail(
  contact: OrgContact,
  orgName: string,
  orgType: string,
  research: string,
  styleContext: string,
  idx: number,
  allContacts: OrgContact[]
): Promise<DraftResult> {
  const crossNote =
    idx > 0
      ? `CROSS-REFERENCE: Also contacting ${allContacts.slice(0, idx).map(c => `${c.name} (${c.title})`).join(" and ")} at ${orgName} today. Mention naturally.`
      : "";

  const raw = await callClaude([{
    role: "user",
    content: `${styleContext}\n\nWrite a partnership outreach email to ${contact.name}, ${contact.title} at ${orgName} (${orgType}).
ENGINE: Hotel booking platform. Say "Engine" never "Engine.com". Hotels only.
VALUE: 1) Preferred hotel rates for org events/members 2) Referral revenue back to the org.
${research ? `RESEARCH:\n${research}\n` : ""}${crossNote}
Angle the pitch to what matters most for a ${contact.title}.
RULES: No em dashes. No generic openers ("Hope this finds you", "I wanted to reach out"). Short soft ask at end.

SUBJECT_A: [curiosity/question style — org-specific]
SUBJECT_B: [value/direct style — leads with the benefit]

[email body]`,
  }]);

  const parsed = parseDraft(raw);
  const firstName = contact.name.split(" ")[0];
  return {
    contact,
    subject: parsed.subject || `${orgName} + Engine`,
    subjectB: parsed.subjectB,
    body:
      parsed.body ||
      `Hi ${firstName},\n\nI'm with Engine, a hotel booking platform built for organizations.\n\nWorth a quick call?\n\nBest,`,
  };
}

// ── Process one org (research + drafts) ───────────────────────────────────────
async function processOrg(
  org: InputOrg,
  styleContext: string,
  useContactFinder: boolean
): Promise<TaskResult> {
  // Run research + (optionally) contact discovery in parallel
  const [research, discoveredContacts] = await Promise.all([
    researchOrg(org.name, org.type),
    useContactFinder && org.contacts.length === 0
      ? findContacts(org.name, org.type, "")
      : Promise.resolve([] as OrgContact[]),
  ]);

  const contacts = org.contacts.length > 0 ? org.contacts : discoveredContacts;
  if (!contacts.length) {
    // Fallback contacts if nothing found
    contacts.push({
      name: "Program Director",
      title: "Director of Programs",
      company: org.name,
      email: "",
      source: "Fallback",
      emailVerified: false,
    });
  }

  // Draft all contacts in parallel
  const drafts = await Promise.all(
    contacts.map((c, i) => draftEmail(c, org.name, org.type, research, styleContext, i, contacts))
  );

  return { orgName: org.name, orgType: org.type, drafts, research };
}

// ── Chunk array ───────────────────────────────────────────────────────────────
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── POST — start a batch run ──────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const { orgs, styleContext, repName, wave } = await req.json() as {
    orgs: InputOrg[];
    styleContext: string;
    repName: string;
    wave: number;
  };

  if (!orgs?.length) return NextResponse.json({ error: "No orgs provided" }, { status: 400 });
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 });

  const runId = crypto.randomUUID();
  const tasks = orgs.map((org, i) => ({
    id: `${runId}-${i}`,
    runId,
    orgName: org.name,
    orgIndex: i,
  }));

  // Write run + task records to Supabase
  await db().from("agent_runs").insert({
    id: runId,
    type: "batch_outreach",
    status: "running",
    total_tasks: orgs.length,
    completed_tasks: 0,
    failed_tasks: 0,
  });
  await db().from("agent_tasks").insert(
    tasks.map(t => ({ id: t.id, run_id: runId, org_name: t.orgName, status: "pending" }))
  );

  // Fan out parallel workers in background (5 orgs at a time)
  after(async () => {
    const CONCURRENCY = 5;
    const orgChunks = chunk(orgs, CONCURRENCY);
    const taskIdByIndex = new Map(tasks.map(t => [t.orgIndex, t.id]));

    for (const batchOrgs of orgChunks) {
      await Promise.all(
        batchOrgs.map(async (org) => {
          const orgIdx = orgs.indexOf(org);
          const taskId = taskIdByIndex.get(orgIdx) || `${runId}-${orgIdx}`;

          await db().from("agent_tasks").update({ status: "running" }).eq("id", taskId);

          try {
            const result = await processOrg(org, styleContext, true);
            await db()
              .from("agent_tasks")
              .update({ status: "done", result: JSON.parse(JSON.stringify(result)) })
              .eq("id", taskId);
          } catch (err) {
            await db()
              .from("agent_tasks")
              .update({ status: "error", error: String(err) })
              .eq("id", taskId);
          }

          // Update completed count
          const { count } = await db()
            .from("agent_tasks")
            .select("*", { count: "exact", head: true })
            .eq("run_id", runId)
            .in("status", ["done", "error"]);
          await db()
            .from("agent_runs")
            .update({ completed_tasks: count ?? 0 })
            .eq("id", runId);
        })
      );
    }

    // Mark run complete
    const { count: failCount } = await db()
      .from("agent_tasks")
      .select("*", { count: "exact", head: true })
      .eq("run_id", runId)
      .eq("status", "error");

    await db()
      .from("agent_runs")
      .update({ status: "done", failed_tasks: failCount ?? 0 })
      .eq("id", runId);

    // Cleanup old runs (keep last 20)
    const { data: oldRuns } = await db()
      .from("agent_runs")
      .select("id")
      .order("created_at", { ascending: true });
    if (oldRuns && oldRuns.length > 20) {
      const toDelete = oldRuns.slice(0, oldRuns.length - 20).map(r => r.id);
      await db().from("agent_runs").delete().in("id", toDelete);
    }
  });

  return NextResponse.json({ runId, total: orgs.length });
}

// ── GET — poll status + completed results ─────────────────────────────────────
export async function GET(req: NextRequest) {
  const runId = req.nextUrl.searchParams.get("runId");
  if (!runId) return NextResponse.json({ error: "runId required" }, { status: 400 });

  const { data: run } = await db().from("agent_runs").select("*").eq("id", runId).single();
  if (!run) return NextResponse.json({ status: "not_found" }, { status: 404 });

  const { data: tasks } = await db()
    .from("agent_tasks")
    .select("id,org_name,status,result,error")
    .eq("run_id", runId);

  return NextResponse.json({
    status: run.status,
    total: run.total_tasks,
    completed: run.completed_tasks,
    failed: run.failed_tasks,
    tasks: (tasks || []).filter(t => t.status === "done").map(t => t.result),
    errors: (tasks || []).filter(t => t.status === "error").map(t => ({ org: t.org_name, error: t.error })),
  });
}
