import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// GET — load all report entries
export async function GET() {
  const { data, error } = await supabase
    .from("report_entries")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ entries: data });
}

// POST — upsert one or many entries
export async function POST(req: NextRequest) {
  const body = await req.json();
  const entries = Array.isArray(body) ? body : [body];

  // Map camelCase → snake_case for DB
  const rows = entries.map((e: Record<string, unknown>) => ({
    id: e.id,
    rep_name: e.repName || "",
    wave: e.wave || 1,
    smerf_category: e.smerfCategory || "",
    organization: e.organization || "",
    contact_name: e.contactName || "",
    title: e.title || "",
    email: e.email || "",
    subject_line: e.subjectLine || "",
    date_sent: e.dateSent || null,
    status: e.status || "Pending",
    stage: e.stage || "Prospecting",
    follow_up_due: e.followUpDue || null,
    follow_up_sent: e.followUpSent || false,
    notes: e.notes || "",
  }));

  const { error } = await supabase
    .from("report_entries")
    .upsert(rows, { onConflict: "id" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

// PATCH — update a single entry field (stage, notes, followUpSent, etc.)
export async function PATCH(req: NextRequest) {
  const { id, ...updates } = await req.json();
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  // Map camelCase fields to snake_case
  const dbUpdates: Record<string, unknown> = {};
  if (updates.stage !== undefined) dbUpdates.stage = updates.stage;
  if (updates.notes !== undefined) dbUpdates.notes = updates.notes;
  if (updates.followUpSent !== undefined) dbUpdates.follow_up_sent = updates.followUpSent;
  if (updates.status !== undefined) dbUpdates.status = updates.status;
  if (updates.dateSent !== undefined) dbUpdates.date_sent = updates.dateSent;
  if (updates.followUpDue !== undefined) dbUpdates.follow_up_due = updates.followUpDue;

  const { error } = await supabase
    .from("report_entries")
    .update(dbUpdates)
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

// DELETE — clear all entries (for "Clear Data")
export async function DELETE() {
  const { error } = await supabase
    .from("report_entries")
    .delete()
    .neq("id", "");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
