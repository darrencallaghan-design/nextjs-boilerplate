import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// rep_profiles table — run this once in your Supabase SQL editor:
//
// CREATE TABLE IF NOT EXISTS rep_profiles (
//   rep_name   TEXT PRIMARY KEY,
//   writing_sample   TEXT    DEFAULT '',
//   extracted_style  TEXT    DEFAULT '',
//   edit_examples    JSONB   DEFAULT '[]',
//   segment_focus    TEXT    DEFAULT '',
//   wave_number      INTEGER DEFAULT 1,
//   updated_at       TIMESTAMPTZ DEFAULT NOW()
// );

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// GET /api/profiles?rep=Kyle  — fetch a single rep's profile
export async function GET(req: NextRequest) {
  const repName = req.nextUrl.searchParams.get("rep");
  if (!repName) return NextResponse.json({ profile: null });

  const { data, error } = await supabase
    .from("rep_profiles")
    .select("*")
    .eq("rep_name", repName)
    .single();

  if (error || !data) return NextResponse.json({ profile: null });

  return NextResponse.json({
    profile: {
      repName:        data.rep_name,
      writingSample:  data.writing_sample  || "",
      extractedStyle: data.extracted_style || "",
      editExamples:   data.edit_examples   || [],
      segmentFocus:   data.segment_focus   || "",
      waveNumber:     data.wave_number     || 1,
    },
  });
}

// POST /api/profiles — upsert a rep's full profile
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { repName, writingSample, extractedStyle, editExamples, segmentFocus, waveNumber } = body;

  if (!repName) return NextResponse.json({ error: "Missing repName" }, { status: 400 });

  const { error } = await supabase
    .from("rep_profiles")
    .upsert(
      {
        rep_name:        repName,
        writing_sample:  writingSample  || "",
        extracted_style: extractedStyle || "",
        edit_examples:   editExamples   || [],
        segment_focus:   segmentFocus   || "",
        wave_number:     waveNumber     || 1,
        updated_at:      new Date().toISOString(),
      },
      { onConflict: "rep_name" }
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
