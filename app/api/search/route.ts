/**
 * AI Search — streaming discovery pipeline driven by a natural language query.
 *
 * POST /api/search
 * Body: { query: string; repName: string }
 * Response: NDJSON stream of events:
 *   { type: "status", message: string }
 *   { type: "org", data: SearchOrgResult }
 *   { type: "done", inserted: number }
 *   { type: "error", message: string }
 */

import { NextRequest } from "next/server";
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

/** Translate a natural-language query into a discovery category string via Claude. */
async function translateQueryToCategory(query: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY || "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{
        role: "user",
        content: `You are a SMERF (Social, Military, Educational, Religious, Fraternal) travel segment expert. Convert the user's search query into a concise discovery category string suitable for finding matching US organizations.

Extract from the query: org types, size/member signals, travel patterns, geography.
Return a single descriptive category string (1-2 sentences, no JSON, no bullets).

User query: ${query}

Category string:`,
      }],
    }),
  });

  if (!res.ok) return query; // fall back to raw query on error
  const data = await res.json();
  const text = (data?.content || [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("\n")
    .trim();
  return text || query;
}

export async function POST(req: NextRequest) {
  const headers = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",          // disable Nginx/CDN buffering
    "Connection": "keep-alive",
  };

  let body: { query?: string; repName?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ type: "error", message: "Invalid request body" }) + "\n", { status: 400, headers });
  }

  const { query, repName } = body;
  if (!query?.trim()) {
    return new Response(JSON.stringify({ type: "error", message: "query is required" }) + "\n", { status: 400, headers });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      // SSE format: "data: <json>\n\n" — forces flush through Vercel/CDN buffering
      const emit = (event: object) => {
        controller.enqueue(enc.encode("data: " + JSON.stringify(event) + "\n\n"));
      };

      try {
        const supabase = db();
        const repNameSafe = repName || "Darren";

        // Load rep profile for style context
        const { data: profileRows } = await supabase
          .from("rep_profiles")
          .select("rep_name, segment_focus, writing_sample, extracted_style, edit_examples")
          .eq("rep_name", repNameSafe)
          .limit(1);

        const rep = profileRows?.[0] || null;

        const styleContext = rep?.writing_sample
          ? `You are ghostwriting for ${repNameSafe} at Engine. Match their exact voice:\n---\n${rep.writing_sample.substring(0, 600)}\n---\nStyle: ${rep.extracted_style || ""}`
          : `You are writing outreach for ${repNameSafe} at Engine, a hotel booking platform.`;

        // Build exclusion list from report_entries + auto_drafts
        const [{ data: contacted }, { data: previousDiscoveries }] = await Promise.all([
          supabase.from("report_entries").select("organization").eq("rep_name", repNameSafe),
          supabase.from("auto_drafts")
            .select("org_name, status, dismiss_reason")
            .eq("rep_name", repNameSafe)
            .or("status.eq.sent,status.eq.pending,and(status.eq.dismissed,dismiss_reason.neq.bad_draft),and(status.eq.dismissed,dismiss_reason.is.null)"),
        ]);

        const existingOrgs = [...new Set([
          ...(contacted || []).map((e: { organization: string }) => e.organization),
          ...(previousDiscoveries || []).map((e: { org_name: string }) => e.org_name),
        ])];

        const normalize = (s: string) => s.toLowerCase().replace(/^(the|a|an)\s+/i, "").replace(/[^a-z0-9]/g, "");
        const existingNorm = new Set(existingOrgs.map(normalize));

        // Translate query to category
        emit({ type: "status", message: "Translating query and searching for orgs…" });
        const category = await translateQueryToCategory(query.trim());

        // Discover orgs — ask for 9 to have buffer after dedup
        const rawOrgs = await discoverOrgsWithCategory(category, existingOrgs, 9);

        // Hard dedup + cap at 5
        const orgs = rawOrgs.filter(o => !existingNorm.has(normalize(o.name))).slice(0, 5);

        if (!orgs.length) {
          emit({ type: "status", message: "No new orgs found matching that query. Try a broader search." });
          emit({ type: "done", inserted: 0 });
          controller.close();
          return;
        }

        emit({ type: "status", message: `Found ${orgs.length} org${orgs.length !== 1 ? "s" : ""}, researching…` });

        let insertedCount = 0;

        for (const org of orgs) {
          try {
            // Research
            const { research, website: foundWebsite } = await researchOrg(org.name, org.type);
            const website = foundWebsite || org.website || "";

            // Scrape + find contacts in parallel
            const [websiteContacts, discoveredContacts] = await Promise.all([
              website ? scrapeWebsiteContacts(website, org.name) : Promise.resolve([]),
              findContacts(org.name, org.type, website),
            ]);

            // Merge and dedup contacts
            const merged = [...websiteContacts, ...discoveredContacts];
            const seen = new Set<string>();
            const contacts = merged.filter(c => {
              const key = c.name.toLowerCase().trim();
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            }).slice(0, 2);

            if (!contacts.length) {
              contacts.push({ name: "Program Director", title: "Director of Programs", email: "", source: "Fallback", emailVerified: false });
            }

            // Draft email for first contact only (keep search fast)
            const contact = contacts[0];
            const draft = await draftEmail(contact, org.name, org.type, research, styleContext);

            if (!draft.body) {
              emit({ type: "error", message: `Could not draft email for ${org.name} — skipping` });
              continue;
            }

            const id = crypto.randomUUID();
            const row: Record<string, unknown> = {
              id,
              rep_name: repNameSafe,
              org_name: org.name,
              org_type: org.type,
              contact_name: contact.name,
              contact_title: contact.title,
              contact_email: contact.email,
              contact_source: contact.source,
              contact_email_verified: contact.emailVerified,
              subject: draft.subject,
              subject_b: draft.subjectB,
              body: draft.body,
              research,
              website,
              status: "pending",
              segment_snapshot: `ai_search: ${query.slice(0, 200)}`,
            };

            let { error: insertErr } = await supabase.from("auto_drafts").insert(row);

            // Retry without segment_snapshot if column doesn't exist yet
            if (insertErr && insertErr.message?.includes("segment_snapshot")) {
              const { segment_snapshot: _dropped, ...rowWithout } = row as Record<string, unknown> & { segment_snapshot: unknown };
              const retry = await supabase.from("auto_drafts").insert(rowWithout);
              insertErr = retry.error;
            }

            if (insertErr) {
              console.error(`[search] Insert failed for "${org.name}":`, insertErr.message);
              emit({ type: "error", message: `Failed to save ${org.name}: ${insertErr.message}` });
              continue;
            }

            insertedCount++;
            emit({
              type: "org",
              data: {
                id,
                org_name: org.name,
                org_type: org.type,
                website,
                research,
                contact_name: contact.name,
                contact_title: contact.title,
                contact_email: contact.email,
                subject: draft.subject,
                body: draft.body,
              },
            });

            await sleep(500);
          } catch (err) {
            console.error(`[search] Failed processing org "${org.name}":`, err);
            emit({ type: "error", message: `Error processing ${org.name}: ${(err as Error).message}` });
          }
        }

        emit({ type: "done", inserted: insertedCount });
      } catch (err) {
        console.error("[search] Top-level error:", err);
        emit({ type: "error", message: (err as Error).message || "Unknown error" });
        emit({ type: "done", inserted: 0 });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers });
}
