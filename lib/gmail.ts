/**
 * Gmail API utilities — shared by the replies cron and followups auto-send.
 *
 * Required Vercel env vars:
 *   GOOGLE_CLIENT_ID       — from Google Cloud Console OAuth 2.0 credential
 *   GOOGLE_CLIENT_SECRET   — from Google Cloud Console OAuth 2.0 credential
 *   GOOGLE_REFRESH_TOKEN   — obtained via /api/gmail/setup?action=auth one-time flow
 *   GMAIL_FROM_EMAIL       — the authenticated user's Gmail address (e.g. darren.callaghan@engine.com)
 */

export interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  from: string;
  fromEmail: string; // extracted email address only
  subject: string;
  date: string;
}

/** Exchange refresh token for a short-lived access token. */
export async function getAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gmail token exchange failed: ${err}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`No access_token in response: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

/** Check if Gmail credentials are configured. */
export function gmailConfigured(): boolean {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REFRESH_TOKEN &&
    process.env.GMAIL_FROM_EMAIL
  );
}

/**
 * Send an email via Gmail API.
 * Returns the Gmail message ID.
 */
export async function sendEmail({
  to,
  subject,
  body,
  fromName,
}: {
  to: string;
  subject: string;
  body: string;
  fromName?: string;
}): Promise<{ messageId: string }> {
  const token = await getAccessToken();

  const fromAddr = process.env.GMAIL_FROM_EMAIL!;
  const from = fromName ? `"${fromName}" <${fromAddr}>` : fromAddr;

  // RFC 2822 formatted email
  const emailLines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
  ];

  const raw = Buffer.from(emailLines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    }
  );

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Gmail send failed: ${JSON.stringify(err)}`);
  }

  const msg = await res.json();
  return { messageId: msg.id };
}

/**
 * Search Gmail inbox for messages matching a query.
 * Returns up to maxResults messages with metadata.
 */
export async function searchMessages(
  query: string,
  maxResults = 20
): Promise<GmailMessage[]> {
  const token = await getAccessToken();

  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(
      query
    )}&maxResults=${maxResults}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!listRes.ok) {
    throw new Error(`Gmail search failed: ${listRes.status}`);
  }

  const list = await listRes.json();
  const messages: { id: string; threadId: string }[] = list.messages || [];
  if (!messages.length) return [];

  // Fetch metadata for each message in parallel
  const details = await Promise.all(
    messages.slice(0, maxResults).map(async (msg) => {
      const detRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=Subject`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!detRes.ok) return null;

      const det = await detRes.json();
      const headers: { name: string; value: string }[] =
        det.payload?.headers || [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
          ?.value || "";

      const fromRaw = getHeader("From");
      // Extract bare email from "Name <email@domain.com>" or "email@domain.com"
      const emailMatch = fromRaw.match(/<([^>]+)>/) || fromRaw.match(/\S+@\S+/);
      const fromEmail = emailMatch
        ? emailMatch[1] || emailMatch[0]
        : fromRaw;

      return {
        id: msg.id,
        threadId: msg.threadId,
        snippet: (det.snippet || "").replace(/&#39;/g, "'").replace(/&amp;/g, "&"),
        from: fromRaw,
        fromEmail: fromEmail.toLowerCase().trim(),
        subject: getHeader("Subject"),
        date: getHeader("Date"),
      } as GmailMessage;
    })
  );

  return details.filter(Boolean) as GmailMessage[];
}

/**
 * Search Gmail for replies from a list of prospect email addresses.
 * Batches emails into groups to stay within Gmail query limits.
 */
export async function findRepliesFrom(
  emails: string[],
  newerThanDays = 60
): Promise<GmailMessage[]> {
  if (!emails.length) return [];

  // Gmail query limits — batch into groups of 8
  const BATCH_SIZE = 8;
  const results: GmailMessage[] = [];

  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const batch = emails.slice(i, i + BATCH_SIZE);
    const fromClause = batch.map((e) => `from:${e}`).join(" OR ");
    const query = `(${fromClause}) in:inbox newer_than:${newerThanDays}d`;

    try {
      const msgs = await searchMessages(query, 50);
      results.push(...msgs);
    } catch {
      // continue with next batch
    }
  }

  return results;
}
