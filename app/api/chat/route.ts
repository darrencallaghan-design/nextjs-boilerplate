/**
 * Unified AI Chat — intent-aware assistant for Engine Agent.
 *
 * POST /api/chat
 * Body: { message: string; threadId?: string; repName?: string }
 * Returns: { reply: ChatReply; threadId: string; messageId: string }
 *
 * Intent types:
 *   discover  — find new SMERF orgs to prospect
 *   pipeline  — query existing pipeline / email activity
 *   draft     — write, re-draft, or retrieve a specific email
 *   mixed     — combination (runs both discover + pipeline in parallel)
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  sleep,
  discoverOrgsWithCategory,
  researchOrg,
  scrapeWebsiteContacts,
  findContacts,
  draftEmail,
} from "@/lib/discovery-agents";

export const maxDuration = 300;

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface OrgResult {
  id: string;
  org_name: string;
  org_type: string;
  website: string;
  research: string;
  contact_name: string;
  contact_title: string;
  contact_email: string;
  subject: string;
  body: string;
  inPipeline?: boolean;
}

interface StatCard {
  label: string;
  value: number | string;
}

interface ActionButton {
  label: string;
  prompt: string;
}

interface ChatReply {
  text: string;
  intent: "discover" | "pipeline" | "draft" | "mixed";
  stats?: StatCard[];
  orgs?: OrgResult[];
  actions?: ActionButton[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function callClaude(prompt: string, maxTokens = 600, useWebSearch = false): Promise<string> {
  const body: Record<string, unknown> = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };
  if (useWebSearch) {
    body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }];
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY || "",
      "anthropic-version": "2023-06-01",
      ...(useWebSearch ? { "anthropic-beta": "web-search-2025-03-05" } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return "";
  const data = await res.json();
  return (data?.content || [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("\n")
    .trim();
}

// ── Intent Classifier ─────────────────────────────────────────────────────────

async function classifyIntent(message: string): Promise<"discover" | "pipeline" | "draft" | "mixed"> {
  const text = await callClaude(
    `Classify this sales rep message into one of four categories:
discover = find or search for new organizations to prospect/pitch
pipeline = ask about existing pipeline, emails sent, replies, account status, activity history
draft = write, re-write, edit, or view a specific email draft
mixed = combination (e.g. "find new orgs AND check if X has replied")

Message: "${message}"

Reply with ONLY one word: discover, pipeline, draft, or mixed`,
    20
  );
  const t = text.toLowerCase().trim();
  if (t.includes("discover")) return "discover";
  if (t.includes("pipeline")) return "pipeline";
  if (t.includes("draft")) return "draft";
  if (t.includes("mixed")) return "mixed";
  // Fallback heuristic
  const lower = message.toLowerCase();
  if (lower.match(/find|search|look for|prospect|new org|discover/)) return "discover";
  if (lower.match(/replied|sent|pipeline|pending|stalled|cold|history|status|how many/)) return "pipeline";
  if (lower.match(/draft|write|re-?write|email for|send to/)) return "draft";
  return "discover";
}

// ── Pipeline Q&A Handler ──────────────────────────────────────────────────────

async function handlePipelineQuery(
  message: string,
  repName: string,
  supabase: ReturnType<typeof db>
): Promise<ChatReply> {
  // Pull live data from both tables
  const [{ data: entries }, { data: drafts }] = await Promise.all([
    supabase
      .from("report_entries")
      .select("id,contact_name,title,email,organization,subject_line,rep_name,follow_up_sent,follow_up_2_sent,follow_up_3_sent,stage,status,replied_at,created_at")
      .eq("rep_name", repName)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("auto_drafts")
      .select("id,org_name,org_type,contact_name,contact_title,contact_email,subject,status,created_at,dismiss_reason")
      .eq("rep_name", repName)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const now = new Date();

  // Compute derived stats
  const sentEmails = entries || [];
  const pendingDrafts = (drafts || []).filter((d: Record<string, unknown>) => d.status === "pending");
  const sentDrafts = (drafts || []).filter((d: Record<string, unknown>) => d.status === "sent");
  const repliedCount = sentEmails.filter((e: Record<string, unknown>) => e.replied_at).length;

  // Find stalled: sent email, no reply, last follow-up > 21 days ago
  const stalled = sentEmails.filter((e: Record<string, unknown>) => {
    if (e.replied_at) return false;
    const lastTouch = new Date(
      (e.follow_up_3_sent || e.follow_up_2_sent || e.follow_up_sent || e.created_at) as string
    );
    const daysSince = (now.getTime() - lastTouch.getTime()) / 86400000;
    return daysSince > 21;
  });

  // Summarise the data as text for Claude
  const context = `
PIPELINE SUMMARY for ${repName}:
- Total orgs contacted (report_entries): ${sentEmails.length}
- Replied: ${repliedCount}
- Pending drafts (not yet sent): ${pendingDrafts.length}
- Sent via auto_drafts: ${sentDrafts.length}
- Stalled accounts (no reply, no touch in 21+ days): ${stalled.length}

RECENT CONTACTS (last 20):
${sentEmails.slice(0, 20).map((e: Record<string, unknown>) =>
  `- ${e.organization} | stage: ${e.stage || "Active"} | replied: ${e.replied_at ? "yes" : "no"} | sent: ${new Date(e.created_at as string).toLocaleDateString()}`
).join("\n")}

PENDING DRAFTS (first 15):
${pendingDrafts.slice(0, 15).map((d: Record<string, unknown>) =>
  `- ${d.org_name} (${d.org_type}) | contact: ${d.contact_name} | "${d.subject}"`
).join("\n")}

STALLED ACCOUNTS (${stalled.length}):
${stalled.slice(0, 10).map((e: Record<string, unknown>) => `- ${e.organization}`).join("\n")}
`.trim();

  const answer = await callClaude(
    `You are an AI assistant for a hotel sales rep named ${repName} using Engine (a hotel booking platform for SMERF organizations).

Here is their live pipeline data:
${context}

Answer this question naturally and concisely (2-4 sentences max). Be specific with numbers. If listing orgs, use bullet points:
"${message}"`,
    400
  );

  // Build stat cards for common query types
  const lower = message.toLowerCase();
  const stats: StatCard[] = [];
  if (lower.match(/sent|email|outreach|activity/)) {
    stats.push({ label: "Emails sent", value: sentEmails.length });
    stats.push({ label: "Replies", value: repliedCount });
  }
  if (lower.match(/pending|draft|discovered/)) {
    stats.push({ label: "Pending drafts", value: pendingDrafts.length });
  }
  if (lower.match(/stall|cold|no.?reply|inactive/)) {
    stats.push({ label: "Stalled accounts", value: stalled.length });
  }

  // Suggest contextual follow-on actions
  const actions: ActionButton[] = [
    { label: "Show stalled accounts", prompt: "Which accounts have gone cold in the last 30 days?" },
    { label: "Pending drafts", prompt: "Show me all my pending drafts" },
    { label: "Find new orgs", prompt: "Find 5 new SMERF orgs I haven't pitched" },
  ].filter(a =>
    !lower.includes(a.label.toLowerCase().split(" ")[0])
  ).slice(0, 3);

  return { text: answer || "Here's what I found in your pipeline.", intent: "pipeline", stats, actions };
}

// ── Discovery Handler ─────────────────────────────────────────────────────────

async function handleDiscover(
  message: string,
  repName: string,
  styleContext: string,
  supabase: ReturnType<typeof db>
): Promise<ChatReply> {
  const normalize = (s: string) => s.toLowerCase().replace(/^(the|a|an)\s+/i, "").replace(/[^a-z0-9]/g, "");

  // Load existing orgs for dedup (not passed to Claude — kills results)
  const [{ data: contacted }, { data: allDrafts }] = await Promise.all([
    supabase.from("report_entries").select("organization").eq("rep_name", repName),
    supabase.from("auto_drafts").select("id,org_name,org_type,website,research,contact_name,contact_title,contact_email,subject,body,status").eq("rep_name", repName),
  ]);

  const allExistingNorm = new Set([
    ...(contacted || []).map((e: { organization: string }) => normalize(e.organization)),
  ]);

  const draftsByNorm = new Map<string, Record<string, unknown>>();
  for (const d of (allDrafts || []) as Record<string, unknown>[]) {
    const n = normalize(d.org_name as string);
    const ex = draftsByNorm.get(n);
    if (!ex || (d.status === "pending" && ex.status !== "pending")) draftsByNorm.set(n, d);
  }

  // Translate message to category then discover
  const categoryText = await callClaude(
    `Convert this sales rep search request into a concise SMERF org category (1-2 sentences, no bullets):
"${message}"
Category:`,
    150
  );
  const category = categoryText || message;

  let rawOrgs = await discoverOrgsWithCategory(category, [], 9);
  if (!rawOrgs.length) {
    await sleep(1500);
    rawOrgs = await discoverOrgsWithCategory(message, [], 9);
  }

  if (!rawOrgs.length) {
    return {
      text: "I couldn't find any orgs matching that search. Try rephrasing — be specific about org type, size, or travel patterns.",
      intent: "discover",
      actions: [
        { label: "Try fraternal associations", prompt: "Find fraternal associations with 100k+ members and national conventions" },
        { label: "Try religious orgs", prompt: "Find large religious denominations with annual national conferences" },
      ],
    };
  }

  const newOrgs = rawOrgs.filter(o => !draftsByNorm.has(normalize(o.name)) && !allExistingNorm.has(normalize(o.name)));
  const pipelineOrgs = rawOrgs.filter(o => draftsByNorm.has(normalize(o.name)));

  const results: OrgResult[] = [];

  // Full pipeline for new orgs
  for (const org of newOrgs.slice(0, 5)) {
    if (results.length >= 5) break;
    try {
      const { research, website: foundWebsite } = await researchOrg(org.name, org.type);
      const website = foundWebsite || org.website || "";

      const [websiteContacts, discoveredContacts] = await Promise.all([
        website ? scrapeWebsiteContacts(website, org.name) : Promise.resolve([]),
        findContacts(org.name, org.type, website),
      ]);

      const merged = [...websiteContacts, ...discoveredContacts];
      const seen = new Set<string>();
      const contacts = merged.filter(c => {
        const key = c.name.toLowerCase().trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 2);

      if (!contacts.length) contacts.push({ name: "Program Director", title: "Director of Programs", email: "", source: "Fallback", emailVerified: false });

      const contact = contacts[0];
      const draft = await draftEmail(contact, org.name, org.type, research, styleContext);
      if (!draft.body) continue;

      const id = crypto.randomUUID();
      const row: Record<string, unknown> = {
        id, rep_name: repName, org_name: org.name, org_type: org.type,
        contact_name: contact.name, contact_title: contact.title, contact_email: contact.email,
        contact_source: contact.source, contact_email_verified: contact.emailVerified,
        subject: draft.subject, subject_b: draft.subjectB, body: draft.body,
        research, website, status: "pending",
        segment_snapshot: `ai_chat: ${message.slice(0, 200)}`,
      };

      let { error: insertErr } = await supabase.from("auto_drafts").insert(row);
      if (insertErr?.message?.includes("segment_snapshot")) {
        const { segment_snapshot: _dropped, ...rowWithout } = row as Record<string, unknown> & { segment_snapshot: unknown };
        const retry = await supabase.from("auto_drafts").insert(rowWithout);
        insertErr = retry.error;
      }

      if (!insertErr) {
        results.push({ id, org_name: org.name, org_type: org.type, website, research, contact_name: contact.name, contact_title: contact.title, contact_email: contact.email, subject: draft.subject, body: draft.body });
      }
      await sleep(400);
    } catch (err) {
      console.error(`[chat/discover] Failed "${org.name}":`, err);
    }
  }

  // Fill with pipeline orgs
  for (const org of pipelineOrgs) {
    if (results.length >= 5) break;
    const existing = draftsByNorm.get(normalize(org.name));
    if (!existing) continue;
    results.push({
      id: existing.id as string, org_name: existing.org_name as string, org_type: existing.org_type as string,
      website: existing.website as string || "", research: existing.research as string || "",
      contact_name: existing.contact_name as string || "", contact_title: existing.contact_title as string || "",
      contact_email: existing.contact_email as string || "", subject: existing.subject as string || "",
      body: existing.body as string || "", inPipeline: true,
    });
  }

  const newCount = results.filter(r => !r.inPipeline).length;
  const pipCount = results.filter(r => r.inPipeline).length;

  let text = "";
  if (newCount > 0 && pipCount > 0) text = `Found ${newCount} new org${newCount !== 1 ? "s" : ""} — added to Discovered. Also surfacing ${pipCount} already in your pipeline.`;
  else if (newCount > 0) text = `Found ${newCount} new org${newCount !== 1 ? "s" : ""} — added to Discovered with research and a draft email ready.`;
  else if (pipCount > 0) text = `${pipCount} org${pipCount !== 1 ? "s" : ""} found — already in your pipeline.`;
  else text = "No new orgs found for that search.";

  const actions: ActionButton[] = [
    { label: "Find more like these", prompt: `Find 5 more orgs similar to: ${results.slice(0, 2).map(r => r.org_name).join(", ")}` },
    { label: "View pending drafts", prompt: "Show me all my pending drafts" },
    { label: "Check pipeline", prompt: "What's my pipeline status right now?" },
  ];

  return {
    text,
    intent: "discover",
    stats: [
      { label: "New orgs added", value: newCount },
      { label: "In pipeline", value: pipCount },
    ],
    orgs: results,
    actions,
  };
}

// ── Draft Handler ─────────────────────────────────────────────────────────────

async function handleDraft(
  message: string,
  repName: string,
  styleContext: string,
  supabase: ReturnType<typeof db>
): Promise<ChatReply> {
  // Try to extract org name from message
  const orgNameRaw = await callClaude(
    `Extract the organization name from this request. Return ONLY the org name, nothing else.
If no specific org is mentioned, return "NONE".
Request: "${message}"`,
    50
  );
  const orgName = orgNameRaw.trim();

  if (orgName && orgName !== "NONE") {
    // Look for existing draft
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const { data: existingDrafts } = await supabase
      .from("auto_drafts")
      .select("*")
      .eq("rep_name", repName)
      .ilike("org_name", `%${orgName}%`)
      .limit(3);

    const existing = (existingDrafts || [])[0] as Record<string, unknown> | undefined;

    // Check for "re-draft" intent
    const isReDraft = message.toLowerCase().match(/re.?draft|re.?write|different angle|new version|try again/);

    if (existing && !isReDraft) {
      return {
        text: `Here's your existing draft for ${existing.org_name}:`,
        intent: "draft",
        orgs: [{
          id: existing.id as string,
          org_name: existing.org_name as string,
          org_type: existing.org_type as string,
          website: existing.website as string || "",
          research: existing.research as string || "",
          contact_name: existing.contact_name as string || "",
          contact_title: existing.contact_title as string || "",
          contact_email: existing.contact_email as string || "",
          subject: existing.subject as string || "",
          body: existing.body as string || "",
          inPipeline: true,
        }],
        actions: [
          { label: `Re-draft with different angle`, prompt: `Re-draft the email for ${existing.org_name} with a different angle` },
          { label: "Find similar orgs", prompt: `Find orgs similar to ${existing.org_name}` },
        ],
      };
    }

    if (existing && isReDraft) {
      // Generate a new draft with a different angle
      const angleInstruction = message.toLowerCase().includes("revenue") ? "focus on referral revenue share back to the org, not hotel rates"
        : message.toLowerCase().includes("logistic") ? "focus on logistics and reducing admin burden for event coordinators"
        : message.toLowerCase().includes("member") ? "focus on the member benefit — easy booking and preferred rates"
        : "try a completely different angle from the previous email — focus on a new value proposition";

      const newBody = await callClaude(
        `${styleContext}

Re-write this outreach email for ${existing.org_name} with a fresh angle: ${angleInstruction}.
Original subject: ${existing.subject}
Org research: ${(existing.research as string || "").slice(0, 300)}
Contact: ${existing.contact_name}, ${existing.contact_title}

Rules: No em dashes. No generic openers. Short soft ask at end. No markdown, no bold.

SUBJECT_A: [new subject line]
SUBJECT_B: [alternative subject]

[email body]`,
        800
      );

      const aMatch = newBody.match(/SUBJECT[_ ]A:\s*(.+)/im);
      const body = newBody.replace(/SUBJECT[_ ][AB]:\s*.+\n*/gim, "").trim();

      return {
        text: `Here's a re-drafted email for ${existing.org_name} with a different angle:`,
        intent: "draft",
        orgs: [{
          id: existing.id as string,
          org_name: existing.org_name as string,
          org_type: existing.org_type as string,
          website: existing.website as string || "",
          research: existing.research as string || "",
          contact_name: existing.contact_name as string || "",
          contact_title: existing.contact_title as string || "",
          contact_email: existing.contact_email as string || "",
          subject: aMatch ? aMatch[1].trim() : `${existing.org_name} + Engine`,
          body,
          inPipeline: false,
        }],
        actions: [
          { label: "Save this draft", prompt: `Save the new draft for ${existing.org_name}` },
          { label: "Try yet another angle", prompt: `Re-draft the email for ${existing.org_name} again with a completely different angle` },
        ],
      };
    }
  }

  // Fallback — just let Claude answer
  const answer = await callClaude(
    `You are an AI assistant for a hotel sales rep at Engine. Answer this question about email drafts:
"${message}"
Be concise (2-3 sentences).`,
    200
  );

  return {
    text: answer || "I can help you write or re-draft an email. Which org would you like me to draft for?",
    intent: "draft",
    actions: [
      { label: "Show pending drafts", prompt: "Show me all my pending drafts" },
      { label: "Find new orgs to pitch", prompt: "Find 5 new SMERF orgs I haven't pitched" },
    ],
  };
}

// ── Main Handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: { message?: string; threadId?: string; repName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { message, threadId: incomingThreadId, repName } = body;
  if (!message?.trim()) return NextResponse.json({ error: "message is required" }, { status: 400 });

  const supabase = db();
  const repNameSafe = repName || "Darren";

  // Load style context
  const { data: profileRows } = await supabase
    .from("rep_profiles")
    .select("rep_name, writing_sample, extracted_style")
    .eq("rep_name", repNameSafe)
    .limit(1);

  const rep = profileRows?.[0] || null;
  const styleContext = rep?.writing_sample
    ? `You are ghostwriting for ${repNameSafe} at Engine. Match their exact voice:\n---\n${rep.writing_sample.substring(0, 600)}\n---\nStyle: ${rep.extracted_style || ""}`
    : `You are writing outreach for ${repNameSafe} at Engine, a hotel booking platform.`;

  // Classify intent
  const intent = await classifyIntent(message);

  // Route to handler(s)
  let reply: ChatReply;

  if (intent === "mixed") {
    // Run pipeline query immediately (fast), then discover
    const [pipelineReply, discoverReply] = await Promise.all([
      handlePipelineQuery(message, repNameSafe, supabase),
      handleDiscover(message, repNameSafe, styleContext, supabase),
    ]);
    reply = {
      text: `${discoverReply.text}\n\n${pipelineReply.text}`,
      intent: "mixed",
      stats: [...(discoverReply.stats || []), ...(pipelineReply.stats || [])],
      orgs: discoverReply.orgs || [],
      actions: [
        ...(discoverReply.actions || []).slice(0, 2),
        ...(pipelineReply.actions || []).slice(0, 1),
      ].slice(0, 3),
    };
  } else if (intent === "pipeline") {
    reply = await handlePipelineQuery(message, repNameSafe, supabase);
  } else if (intent === "draft") {
    reply = await handleDraft(message, repNameSafe, styleContext, supabase);
  } else {
    reply = await handleDiscover(message, repNameSafe, styleContext, supabase);
  }

  // Persist thread + messages to Supabase
  let threadId = incomingThreadId;

  if (!threadId) {
    // Create a new thread — title from first 60 chars of message
    const title = message.slice(0, 60) + (message.length > 60 ? "…" : "");
    threadId = crypto.randomUUID();
    await supabase.from("chat_threads").insert({
      id: threadId,
      rep_name: repNameSafe,
      title,
    }).then(() => {}); // best-effort — don't fail the request if table missing
  } else {
    // Update updated_at
    await supabase.from("chat_threads").update({ updated_at: new Date().toISOString() }).eq("id", threadId).then(() => {});
  }

  const userMsgId = crypto.randomUUID();
  const asstMsgId = crypto.randomUUID();

  await supabase.from("chat_messages").insert([
    { id: userMsgId, thread_id: threadId, rep_name: repNameSafe, role: "user", content: { text: message }, intent },
    { id: asstMsgId, thread_id: threadId, rep_name: repNameSafe, role: "assistant", content: reply, intent },
  ]).then(() => {}); // best-effort

  return NextResponse.json({ reply, threadId, messageId: asstMsgId });
}
