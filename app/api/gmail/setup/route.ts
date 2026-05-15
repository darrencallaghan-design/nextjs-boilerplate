/**
 * Gmail OAuth Setup — one-time flow to obtain a refresh token.
 *
 * SETUP INSTRUCTIONS:
 * ──────────────────────────────────────────────────────────────────────────
 * 1. Go to https://console.cloud.google.com/
 * 2. Create a project (or select existing)
 * 3. Enable the Gmail API: APIs & Services → Library → Gmail API → Enable
 * 4. Create credentials: APIs & Services → Credentials → + Create Credentials → OAuth 2.0 Client ID
 *    - Application type: Web application
 *    - Name: Engine Agent
 *    - Authorized redirect URIs: https://engine-agent.vercel.app/api/gmail/setup?action=callback
 *      (also add http://localhost:3000/api/gmail/setup?action=callback for local testing)
 * 5. Copy Client ID and Client Secret → add to Vercel env vars:
 *    GOOGLE_CLIENT_ID=your_client_id
 *    GOOGLE_CLIENT_SECRET=your_client_secret
 *    GMAIL_FROM_EMAIL=darren.callaghan@engine.com
 * 6. Redeploy Vercel, then visit:
 *    https://engine-agent.vercel.app/api/gmail/setup?action=auth
 * 7. Sign in with your Engine Google account
 * 8. Copy the refresh token shown → add to Vercel env vars:
 *    GOOGLE_REFRESH_TOKEN=your_refresh_token
 * 9. Redeploy — Gmail features are now active!
 * ──────────────────────────────────────────────────────────────────────────
 *
 * SCOPES REQUESTED:
 *   gmail.readonly — read inbox (for reply detection)
 *   gmail.send     — send emails (for auto-send follow-ups)
 */

import { NextRequest, NextResponse } from "next/server";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
].join(" ");

export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  // ── Step 1: Redirect to Google OAuth consent screen ────────────────────
  if (action === "auth") {
    if (!clientId) {
      return new NextResponse(
        html(`
          <h2 style="color:#E53935">Missing GOOGLE_CLIENT_ID</h2>
          <p>Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to Vercel env vars first, then redeploy and try again.</p>
          <p>See the setup instructions in <code>app/api/gmail/setup/route.ts</code>.</p>
        `),
        { headers: { "Content-Type": "text/html" } }
      );
    }

    const redirectUri = buildRedirectUri(req);
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", SCOPES);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent"); // force refresh token

    return NextResponse.redirect(authUrl.toString());
  }

  // ── Step 2: Exchange code for tokens ───────────────────────────────────
  if (action === "callback") {
    const code = req.nextUrl.searchParams.get("code");
    const error = req.nextUrl.searchParams.get("error");

    if (error || !code) {
      return new NextResponse(
        html(`<h2 style="color:#E53935">OAuth Error: ${error || "no code returned"}</h2><p>Try again from <a href="?action=auth">?action=auth</a></p>`),
        { headers: { "Content-Type": "text/html" } }
      );
    }

    if (!clientId || !clientSecret) {
      return new NextResponse(
        html(`<h2 style="color:#E53935">Missing credentials</h2><p>GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not set in env vars.</p>`),
        { headers: { "Content-Type": "text/html" } }
      );
    }

    const redirectUri = buildRedirectUri(req);

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    const tokens = await tokenRes.json();

    if (!tokens.refresh_token) {
      return new NextResponse(
        html(`
          <h2 style="color:#E53935">No refresh token returned</h2>
          <p>This usually means the account already granted access without "offline" mode. Try:</p>
          <ol>
            <li>Go to <a href="https://myaccount.google.com/permissions" target="_blank">Google Account Permissions</a></li>
            <li>Revoke "Engine Agent" access</li>
            <li>Return to <a href="?action=auth">?action=auth</a> and grant access again</li>
          </ol>
          <pre>${JSON.stringify(tokens, null, 2)}</pre>
        `),
        { headers: { "Content-Type": "text/html" } }
      );
    }

    return new NextResponse(
      html(`
        <h2 style="color:#009262">✓ Gmail connected!</h2>
        <p>Copy this refresh token and add it to <strong>Vercel env vars</strong> as <code>GOOGLE_REFRESH_TOKEN</code>, then redeploy:</p>
        <div style="background:#f5f5f5;padding:16px;border-radius:8px;font-family:monospace;font-size:13px;word-break:break-all;border:2px solid #009262;margin:16px 0">
          ${tokens.refresh_token}
        </div>
        <p style="color:#616368;font-size:13px">Also confirm <code>GMAIL_FROM_EMAIL=darren.callaghan@engine.com</code> is set.</p>
        <p style="color:#616368;font-size:13px">After redeploying, reply detection and auto-send will activate on the next cron run.</p>
      `),
      { headers: { "Content-Type": "text/html" } }
    );
  }

  // ── Default: show status ────────────────────────────────────────────────
  const configured = !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REFRESH_TOKEN &&
    process.env.GMAIL_FROM_EMAIL
  );

  return new NextResponse(
    html(`
      <h2>Gmail Setup Status</h2>
      <table style="border-collapse:collapse;font-size:14px">
        ${envRow("GOOGLE_CLIENT_ID", process.env.GOOGLE_CLIENT_ID)}
        ${envRow("GOOGLE_CLIENT_SECRET", process.env.GOOGLE_CLIENT_SECRET)}
        ${envRow("GOOGLE_REFRESH_TOKEN", process.env.GOOGLE_REFRESH_TOKEN)}
        ${envRow("GMAIL_FROM_EMAIL", process.env.GMAIL_FROM_EMAIL)}
      </table>
      ${configured
        ? `<p style="color:#009262;font-weight:600;margin-top:16px">✓ All set! Gmail integration is active.</p>`
        : `<p style="margin-top:16px"><a href="?action=auth" style="background:#F5A623;color:#1A1A1A;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">Start Gmail OAuth →</a></p>`
      }
    `),
    { headers: { "Content-Type": "text/html" } }
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function buildRedirectUri(req: NextRequest): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}/api/gmail/setup?action=callback`;
}

function envRow(name: string, value: string | undefined): string {
  const set = !!value;
  return `<tr>
    <td style="padding:6px 12px;border:1px solid #E8E5E0;font-family:monospace">${name}</td>
    <td style="padding:6px 12px;border:1px solid #E8E5E0;color:${set ? "#009262" : "#E53935"};font-weight:600">${set ? "✓ set" : "✗ missing"}</td>
  </tr>`;
}

function html(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Engine Agent — Gmail Setup</title>
    <style>
      body { font-family: Arial, Helvetica, sans-serif; max-width: 640px; margin: 60px auto; padding: 0 20px; color: #10121A; background: #F8F6F2; }
      h2 { font-size: 20px; margin-bottom: 8px; }
      a { color: #4BBFC4; }
      code { background: #eee; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
      pre { background: #f5f5f5; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; }
    </style>
  </head><body>${body}</body></html>`;
}
