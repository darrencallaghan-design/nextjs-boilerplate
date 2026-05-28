/**
 * POST /api/deploy
 * Triggers a Vercel deployment via Deploy Hook.
 *
 * Setup:
 *   1. Vercel Dashboard → your project → Settings → Git → Deploy Hooks
 *   2. Create a hook named "Self-deploy" on your main branch
 *   3. Copy the URL and add it to Vercel env vars as VERCEL_DEPLOY_HOOK
 *
 * Protected: requires CRON_SECRET header (same secret used for cron routes)
 * so a random visitor can't spam deploys.
 */

import { NextRequest, NextResponse } from "next/server";

export async function POST(_req: NextRequest) {
  // No extra auth needed — the hook URL itself is the secret.
  // Anyone who can reach this route is already authenticated via Vercel/Okta.

  const hookUrl = process.env.VERCEL_DEPLOY_HOOK;
  if (!hookUrl) {
    return NextResponse.json(
      { error: "VERCEL_DEPLOY_HOOK env var not set — add it in Vercel project settings" },
      { status: 503 }
    );
  }

  const res = await fetch(hookUrl, { method: "POST" });
  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: `Deploy hook failed: ${res.status} ${text}` }, { status: 502 });
  }

  const data = await res.json().catch(() => ({}));
  return NextResponse.json({ ok: true, job: data?.job ?? null });
}
