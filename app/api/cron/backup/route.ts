/**
 * Daily Backup — Cron
 *
 * Runs every day at 2am UTC (before other crons).
 * Snapshots all report_entries into report_entries_backup, keyed by date.
 * Retains 14 days of backups then auto-prunes older ones.
 *
 * Also exposes GET ?action=restore&date=YYYY-MM-DD to restore from a backup.
 *
 * Supabase SQL (run once):
 *
 * create table if not exists report_entries_backup (
 *   backup_date date not null,
 *   id text, rep_name text, wave integer, smerf_category text,
 *   organization text, contact_name text, title text, email text,
 *   subject_line text, date_sent date, status text, stage text,
 *   follow_up_due date, follow_up_sent boolean,
 *   follow_up_2_due date, follow_up_2_sent boolean,
 *   follow_up_3_due date, follow_up_3_sent boolean,
 *   notes text, source text, replied_at timestamptz,
 *   reply_snippet text, created_at timestamptz,
 *   primary key (backup_date, id)
 * );
 * alter table report_entries_backup enable row level security;
 * create policy "allow_all" on report_entries_backup for all using (true) with check (true);
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const maxDuration = 60;

const RETAIN_DAYS = 14;

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

export async function GET(req: NextRequest) {
  // Auth
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const action = req.nextUrl.searchParams.get("action");

  // ── RESTORE from a specific backup date ─────────────────────────────────────
  if (action === "restore") {
    const date = req.nextUrl.searchParams.get("date");
    if (!date) return NextResponse.json({ error: "Missing date param (YYYY-MM-DD)" }, { status: 400 });

    const { data: backup, error: fetchErr } = await db()
      .from("report_entries_backup")
      .select("*")
      .eq("backup_date", date);

    if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
    if (!backup?.length) return NextResponse.json({ error: `No backup found for ${date}` }, { status: 404 });

    // Wipe current entries and restore from backup
    const { error: delErr } = await db().from("report_entries").delete().neq("id", "");
    if (delErr) return NextResponse.json({ error: `Delete failed: ${delErr.message}` }, { status: 500 });

    // Strip backup_date before reinserting
    const rows = backup.map(({ backup_date: _d, ...row }) => row);
    const { error: insertErr } = await db().from("report_entries").insert(rows);
    if (insertErr) return NextResponse.json({ error: `Restore failed: ${insertErr.message}` }, { status: 500 });

    return NextResponse.json({ ok: true, restored: rows.length, from: date });
  }

  // ── LIST available backup dates ──────────────────────────────────────────────
  if (action === "list") {
    const { data, error } = await db()
      .from("report_entries_backup")
      .select("backup_date")
      .order("backup_date", { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const dates = [...new Set((data || []).map(r => r.backup_date))];
    return NextResponse.json({ backups: dates });
  }

  // ── DEFAULT: snapshot today ──────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);

  // Load all current entries
  const { data: entries, error: loadErr } = await db()
    .from("report_entries")
    .select("*");

  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
  if (!entries?.length) return NextResponse.json({ ok: true, backed_up: 0, message: "Nothing to back up" });

  // Delete today's existing backup (idempotent re-run)
  await db().from("report_entries_backup").delete().eq("backup_date", today);

  // Insert snapshot
  const rows = entries.map(e => ({ ...e, backup_date: today }));
  const { error: insertErr } = await db().from("report_entries_backup").insert(rows);
  if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

  // Prune backups older than RETAIN_DAYS
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETAIN_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  await db().from("report_entries_backup").delete().lt("backup_date", cutoffStr);

  return NextResponse.json({
    ok: true,
    backed_up: entries.length,
    date: today,
    message: `Snapshot complete — ${entries.length} rows backed up`,
  });
}
