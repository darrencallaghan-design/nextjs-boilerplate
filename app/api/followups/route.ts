/**
 * GET /api/followups
 * Returns pre-drafted follow-up emails from the drafted_followups table,
 * joined with the matching report_entry data so the UI has everything it needs.
 *
 * PATCH /api/followups
 * Update a drafted follow-up status (pending → sent | dismissed)
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

export async function GET(req: NextRequest) {
  const repName = req.nextUrl.searchParams.get("repName");

  let query = db()
    .from("drafted_followups")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (repName) {
    query = query.eq("rep_name", repName);
  }

  const { data: drafts, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!drafts?.length) return NextResponse.json({ drafts: [] });

  // Fetch matching report entries
  const entryIds = [...new Set(drafts.map(d => d.entry_id))];
  const { data: entries } = await db()
    .from("report_entries")
    .select("id,contact_name,title,email,organization,stage,smerf_category,follow_up_due,follow_up_2_due,follow_up_3_due")
    .in("id", entryIds);

  const entryMap = new Map((entries || []).map(e => [e.id, e]));

  const result = drafts.map(d => ({
    ...d,
    entry: entryMap.get(d.entry_id) || null,
  }));

  return NextResponse.json({ drafts: result });
}

export async function PATCH(req: NextRequest) {
  const { id, status } = await req.json();
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  if (!["pending", "sent", "dismissed"].includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const { error } = await db()
    .from("drafted_followups")
    .update({ status })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
