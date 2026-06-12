"use client";

import { useState, useCallback, useEffect, useRef } from "react";

const ACCENT = "#F5A623";
const ACCENT_TEXT = "#FFFFFF";
const INDIGO = "#6C6FEF";
const INDIGO_BG = "#F0F0FD";
const BG = "#F5F6FA";
const SURFACE = "#FFFFFF";
const SURFACE_TINT = "#FAFBFF";
const SIDEBAR_BG = "#F8F9FF";
const BORDER = "#EAECF2";
const MUTED = "#9CA3AF";
const TEXT = "#111827";
const TEXT_SECONDARY = "#6B7280";
const SUCCESS = "#059669";
const ERROR = "#DC2626";
const INFO = "#6C6FEF";

const FALLBACK_ROLES = ["Executive Director", "VP of Programs", "Director of Events"];

const STYLE_KEY = "engine-agent-style-v2";
const REPORT_KEY = "engine-agent-reports-v1";
const WAVE_KEY = "engine-agent-wave-v1";

const STAGES: DealStage[] = ["Prospecting", "Discovery", "Proposal", "Contracted", "Closed Won", "Closed Lost"];
const STAGE_COLORS: Record<DealStage, { bg: string; text: string }> = {
  "Prospecting": { bg: "rgba(158,158,158,0.12)", text: "#616368" },
  "Discovery":   { bg: "rgba(20,118,216,0.1)",  text: "#1476D8" },
  "Proposal":    { bg: "rgba(253,75,35,0.1)",   text: "#FD4B23" },
  "Contracted":  { bg: "rgba(0,146,98,0.1)",    text: "#009262" },
  "Closed Won":  { bg: "rgba(0,100,60,0.12)",   text: "#006437" },
  "Closed Lost": { bg: "rgba(158,158,158,0.15)", text: "#9E9E9E" },
};

interface Contact {
  name: string;
  title: string;
  company: string;
  email: string;
  source: string;
  emailVerified?: boolean; // true only if the email was found on a real webpage
  orgWebsite?: string;     // org's primary website, surfaced during batch research
}

interface Draft {
  to: string;
  email: string;
  subject: string;
  subjectB?: string;           // A/B variant B subject line
  selectedVariant?: "A" | "B"; // which subject the rep chose
  body: string;
  sentAt: string | null;
  edited?: string;
  research?: string;
  orgType?: string;
  company?: string;
  contactTitle?: string;
  reportId?: string;
  emailVerified?: boolean;
  contactSource?: string;
}

type DealStage = "Prospecting" | "Discovery" | "Proposal" | "Contracted" | "Closed Won" | "Closed Lost";

interface ReportEntry {
  id: string;
  repName: string;
  wave: number;
  smerfCategory: string;
  organization: string;
  contactName: string;
  title: string;
  email: string;
  subjectLine: string;
  dateSent: string | null;
  status: "Sent" | "Fallback" | "Pending";
  stage: DealStage;
  followUpDue: string | null;
  followUpSent: boolean;
  followUp2Due: string | null;
  followUp2Sent: boolean;
  followUp3Due: string | null;
  followUp3Sent: boolean;
  notes: string;
  subjectVariant?: "A" | "B";  // which subject was sent (for A/B tracking)
  source?: string;              // "Daily Discovery" for cron-sourced entries, null for manual
  repliedAt?: string | null;   // ISO timestamp when prospect replied (set by reply detection cron)
  replySnippet?: string | null; // first 300 chars of their reply
}

interface SentItem {
  to: string;
  email: string;
  subject: string;
  sentAt: string;
}

interface StepState {
  label: string;
  state: string;
}

interface StyleProfile {
  repName: string;
  writingSample: string;
  extractedStyle: string; // Claude's analysis of their writing
  editExamples: string[]; // saved edits to learn from
  segmentFocus: string;   // rep's target industries, org types, partner categories
  discoveryEnabled?: boolean; // daily SMERF org discovery cron (opt-in per rep)
}


function fallbackContacts(orgName: string): Contact[] {
  const names = ["Sarah Mitchell", "James Thornton", "Ana Rivera"];
  const domain = orgName.toLowerCase().replace(/[^a-z0-9]/g, "") + ".org";
  return names.map((name, i) => ({
    name, title: FALLBACK_ROLES[i] || "Director", company: orgName,
    email: name.split(" ")[0].toLowerCase() + "@" + domain, source: "Fallback",
  }));
}

function categorizeSmerf(orgType: string): string {
  return orgType?.trim() || "Unspecified";
}

function parseJSON(raw: string) {
  try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { return null; }
}

// Strips em and en dashes — common AI tells — replacing them with natural punctuation
function stripEmDashes(text: string): string {
  return text
    .replace(/ [—–] /g, ", ")  // spaced em or en dash → comma
    .replace(/[—–] /g, "")     // leading dash
    .replace(/ [—–]/g, "")     // trailing dash
    .replace(/[—–]/g, ", ");   // bare dash fallback
}

// Parses an email written in plain text format: SUBJECT: ...\n\n[body]
// Falls back to JSON parsing for backwards compatibility.
function parseDraft(raw: string): { subject: string; subjectB?: string; body: string } | null {
  // Try JSON first
  const json = parseJSON(raw);
  if (json?.subject && json?.body) return {
    subject: stripEmDashes(json.subject),
    subjectB: json.subjectB ? stripEmDashes(json.subjectB) : undefined,
    body: stripEmDashes(json.body),
  };

  // Try A/B subject format: SUBJECT_A + SUBJECT_B
  const subjectAMatch = raw.match(/^SUBJECT[_ ]A:\s*(.+)$/im);
  const subjectBMatch = raw.match(/^SUBJECT[_ ]B:\s*(.+)$/im);
  if (subjectAMatch) {
    const subject = subjectAMatch[1].trim();
    const subjectB = subjectBMatch ? subjectBMatch[1].trim() : undefined;
    const body = raw.replace(/^SUBJECT[_ ][AB]:\s*.+\n*/gim, "").trim();
    if (subject && body) return { subject: stripEmDashes(subject), subjectB: subjectB ? stripEmDashes(subjectB) : undefined, body: stripEmDashes(body) };
  }

  // Try plain text: look for SUBJECT: line
  const subjectMatch = raw.match(/^SUBJECT:\s*(.+)$/im);
  if (subjectMatch) {
    const subject = subjectMatch[1].trim();
    const body = raw.replace(/^SUBJECT:\s*.+\n*/im, "").trim();
    if (subject && body) return { subject: stripEmDashes(subject), body: stripEmDashes(body) };
  }

  // Last resort: treat first line as subject, rest as body
  const lines = raw.trim().split("\n");
  if (lines.length >= 3) {
    return {
      subject: stripEmDashes(lines[0].replace(/^subject:\s*/i, "").trim()),
      body: stripEmDashes(lines.slice(1).join("\n").trim()),
    };
  }

  return null;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── DATE HELPERS ──────────────────────────────────────────────────────────────
// Build an ISO date string (YYYY-MM-DD) from local time — avoids UTC offset shifting
function toISOLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Add n days and return ISO string
function addDaysISO(d: Date, n: number): string {
  const x = new Date(d);
  x.setDate(d.getDate() + n);
  return toISOLocal(x);
}

// Parse either ISO (YYYY-MM-DD) or legacy M/D/YYYY into a local-midnight Date
function parseLocalDate(s: string): Date {
  if (!s) return new Date(NaN);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const [y, mo, day] = s.split("-").map(Number);
    return new Date(y, mo - 1, day);
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(s)) {
    const [mo, day, y] = s.split("/").map(Number);
    return new Date(y, mo - 1, day);
  }
  return new Date(s);
}

// Display helper — renders any stored date as M/D/YYYY for the UI
function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(s)) return s; // already M/D/YYYY
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const [y, mo, day] = s.split("-").map(Number);
    return `${mo}/${day}/${y}`;
  }
  return s;
}

async function callClaude(messages: { role: string; content: string }[], retries = 5): Promise<string> {
  await sleep(1500); // pace calls to stay under Tier 1 TPM limits
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (res.status === 429 && retries > 0) {
    const wait = retries * 10000; // 50s, 40s, 30s, 20s, 10s
    await sleep(wait);
    return callClaude(messages, retries - 1);
  }
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  const data = await res.json();
  return data?.text || "";
}

async function lookupZoomInfo(orgName: string, orgType: string, orgContext: string) {
  const res = await fetch("/api/zoominfo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orgName, orgType, orgContext }),
  });
  if (!res.ok) throw new Error(`ZoomInfo server error: ${res.status}`);
  const data = await res.json();
  return data?.text || "";
}

function extractContactsFromText(text: string, orgName: string): Contact[] {
  const json = parseJSON(text);
  if (json) {
    const tries = [json?.contacts, json?.data?.contacts, json?.results, json?.data];
    for (const t of tries) {
      if (Array.isArray(t) && t.length > 0) {
        return (t as Record<string, string>[]).slice(0, 3).map(c => ({
          name: c?.name || c?.full_name || "Unknown",
          title: c?.title || c?.job_title || "Director",
          company: c?.company || c?.organization || orgName,
          email: c?.email || c?.email_address || "",
          source: "ZoomInfo",
        }));
      }
    }
  }
  return [];
}

function Steps({ steps }: { steps: StepState[] }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", position: "relative", marginBottom: 12 }}>
      {steps.map((step, i) => (
        <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", position: "relative" }}>
          {i < steps.length - 1 && (
            <div style={{ position: "absolute", top: 11, left: "50%", width: "100%", height: 2, background: step.state === "done" ? SUCCESS : BORDER, zIndex: 0 }} />
          )}
          <div style={{
            width: 22, height: 22, borderRadius: "50%", zIndex: 1, position: "relative",
            border: `2px solid ${step.state === "done" ? SUCCESS : step.state === "active" ? ACCENT : step.state === "error" ? ERROR : BORDER}`,
            background: step.state === "done" ? SUCCESS : step.state === "active" ? "rgba(253,75,35,0.08)" : step.state === "error" ? ERROR : SURFACE,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 9, fontWeight: 700,
            color: step.state === "done" ? "#fff" : step.state === "active" ? ACCENT : step.state === "error" ? "#fff" : MUTED,
          }}>
            {step.state === "done" ? "✓" : step.state === "error" ? "✕" : i + 1}
          </div>
          <div style={{ fontSize: 9, fontWeight: 500, color: step.state === "done" ? SUCCESS : step.state === "active" ? ACCENT : MUTED, marginTop: 4, textAlign: "center", lineHeight: 1.3 }}>
            {step.label}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── SEGMENT FOCUS HELPERS ─────────────────────────────────────────────────────
const SEG_DELIMITERS = {
  types:    "ORG_TYPES::",
  examples: "EXAMPLES::",
  travel:   "TRAVEL::",
};

function parseSegment(raw: string): { types: string; examples: string; travel: string } {
  // If it uses the structured format, parse it out
  if (raw.includes(SEG_DELIMITERS.types)) {
    const get = (key: keyof typeof SEG_DELIMITERS, nextKey?: keyof typeof SEG_DELIMITERS) => {
      const start = raw.indexOf(SEG_DELIMITERS[key]);
      if (start === -1) return "";
      const after = raw.slice(start + SEG_DELIMITERS[key].length);
      if (nextKey && raw.includes(SEG_DELIMITERS[nextKey])) {
        return after.slice(0, after.indexOf(SEG_DELIMITERS[nextKey])).trim();
      }
      return after.trim();
    };
    return {
      types:    get("types", "examples"),
      examples: get("examples", "travel"),
      travel:   get("travel"),
    };
  }
  // Legacy: single free-text block — put it all in types
  return { types: raw, examples: "", travel: "" };
}

function formatSegment(types: string, examples: string, travel: string): string {
  const parts: string[] = [];
  if (types.trim())    parts.push(`${SEG_DELIMITERS.types}${types.trim()}`);
  if (examples.trim()) parts.push(`${SEG_DELIMITERS.examples}${examples.trim()}`);
  if (travel.trim())   parts.push(`${SEG_DELIMITERS.travel}${travel.trim()}`);
  return parts.join("\n\n");
}

// ── STYLE SETUP MODAL ─────────────────────────────────────────────────────────
function StyleSetup({ onComplete }: { onComplete: (profile: StyleProfile) => void }) {
  const [repName, setRepName] = useState("");
  const [sample, setSample] = useState("");
  const [segTypes, setSegTypes] = useState("");
  const [segExamples, setSegExamples] = useState("");
  const [segTravel, setSegTravel] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState("");

  const analyze = async () => {
    if (!repName.trim()) { setError("Please enter your name."); return; }
    if (sample.trim().length < 20) { setError("Please paste at least a short email or paragraph."); return; }
    setError("");
    setAnalyzing(true);
    try {
      const raw = await callClaude([{
        role: "user",
        content: `Analyze this person's writing style from their email sample. Extract: tone (formal/casual/warm/direct), typical length, how they open emails, how they sign off, what they lead with, any distinctive phrases or patterns.

Name: ${repName}
Their writing sample:
---
${sample}
---

Return a concise style guide (3-5 sentences) that can be used to write future emails that sound exactly like them. Be specific about patterns you notice.`
      }]);

      onComplete({
        repName: repName.trim(),
        writingSample: sample.trim(),
        extractedStyle: raw,
        editExamples: [],
        segmentFocus: formatSegment(segTypes, segExamples, segTravel),
      });
    } catch {
      setError("Something went wrong analyzing your style. Try again.");
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(16,18,26,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, backdropFilter: "blur(4px)" }}>
      <div style={{ background: SURFACE, borderRadius: 14, padding: 36, maxWidth: 500, width: "90%", boxShadow: "0 20px 60px rgba(0,0,0,0.15)" }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: ACCENT, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>First time setup</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: TEXT, marginBottom: 8 }}>Let's learn how you write</div>
        <div style={{ fontSize: 13, color: TEXT_SECONDARY, marginBottom: 24, lineHeight: 1.6 }}>
          Paste an email you've sent before — a prospecting email, a follow-up, anything. The AI will read it and write all future drafts in your exact style.
        </div>

        <div style={{ fontSize: 12, fontWeight: 500, color: TEXT_SECONDARY, marginBottom: 6 }}>Your name</div>
        <input
          value={repName}
          onChange={e => setRepName(e.target.value)}
          placeholder="Your name"
          style={{ width: "100%", background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: "10px 14px", color: TEXT, fontFamily: "inherit", fontSize: 14, outline: "none", boxSizing: "border-box", marginBottom: 16 }}
        />

        <div style={{ fontSize: 12, fontWeight: 500, color: TEXT_SECONDARY, marginBottom: 6 }}>
          Paste an email you've written <span style={{ color: MUTED, fontWeight: 400 }}>(or write a few sentences in your style)</span>
        </div>
        <textarea
          value={sample}
          onChange={e => setSample(e.target.value)}
          placeholder={"Hi [Name],\n\nWanted to reach out about..."}
          style={{ width: "100%", background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: "10px 14px", color: TEXT, fontFamily: "inherit", fontSize: 13, outline: "none", resize: "vertical", minHeight: 140, boxSizing: "border-box", lineHeight: 1.65 }}
        />

        <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: TEXT_SECONDARY }}>
            Your target segment <span style={{ fontWeight: 400, color: MUTED }}>(recommended — makes batch search accurate)</span>
          </div>

          {/* Section 1 */}
          <div style={{ background: BG, borderRadius: 8, padding: "12px 14px", border: `1px solid ${segTypes.trim() ? ACCENT : BORDER}` }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: TEXT, marginBottom: 4 }}>1. Target org types & categories</div>
            <div style={{ fontSize: 11, color: MUTED, marginBottom: 6 }}>What kinds of organizations do you go after? List the categories.</div>
            <textarea
              value={segTypes}
              onChange={e => setSegTypes(e.target.value)}
              placeholder={"e.g. TMS platforms, fleet payment companies, trucking associations, factoring companies, motorcoach operators\n\nOr: SMERF associations — social, military, educational, religious, fraternal groups that hold member events"}
              style={{ width: "100%", background: SURFACE, border: "none", borderRadius: 6, padding: "8px 10px", color: TEXT, fontFamily: "inherit", fontSize: 12, outline: "none", resize: "vertical", minHeight: 70, boxSizing: "border-box", lineHeight: 1.6 }}
            />
          </div>

          {/* Section 2 */}
          <div style={{ background: BG, borderRadius: 8, padding: "12px 14px", border: `1px solid ${segExamples.trim() ? ACCENT : BORDER}` }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: TEXT, marginBottom: 4 }}>2. Named examples</div>
            <div style={{ fontSize: 11, color: MUTED, marginBottom: 6 }}>List 5–10 companies you'd recognize as a perfect target.</div>
            <textarea
              value={segExamples}
              onChange={e => setSegExamples(e.target.value)}
              placeholder={"e.g. Trimble, Samsara, OOIDA, RTS Financial, TruckerPath, APEX Capital, ATA, NASTC\n\nOr: American Legion, NAACP, Phi Beta Sigma, National FFA, Knights of Columbus"}
              style={{ width: "100%", background: SURFACE, border: "none", borderRadius: 6, padding: "8px 10px", color: TEXT, fontFamily: "inherit", fontSize: 12, outline: "none", resize: "vertical", minHeight: 60, boxSizing: "border-box", lineHeight: 1.6 }}
            />
          </div>

          {/* Section 3 */}
          <div style={{ background: BG, borderRadius: 8, padding: "12px 14px", border: `1px solid ${segTravel.trim() ? ACCENT : BORDER}` }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: TEXT, marginBottom: 4 }}>3. Why Engine is the right fit</div>
            <div style={{ fontSize: 11, color: MUTED, marginBottom: 6 }}>What makes these orgs a strong Engine partner? What's the value prop and partnership angle that lands best with them?</div>
            <textarea
              value={segTravel}
              onChange={e => setSegTravel(e.target.value)}
              placeholder={"e.g. Fleet and trucking companies are ideal because Engine is the only hotel platform built for fleets — WEX/EFS acceptance, truck-friendly search, real-time P&L per driver. The pitch is a complete lodging solution they can offer their driver network, not just a discount.\n\nOr: SMERF associations are ideal because Engine becomes a member benefit — preferred hotel rates for events plus referral revenue back to the org. It's a value-add for members, not just another vendor."}
              style={{ width: "100%", background: SURFACE, border: "none", borderRadius: 6, padding: "8px 10px", color: TEXT, fontFamily: "inherit", fontSize: 12, outline: "none", resize: "vertical", minHeight: 60, boxSizing: "border-box", lineHeight: 1.6 }}
            />
          </div>
          <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.5 }}>You can update this any time from your profile. The more detail, the better your batch search results.</div>
        </div>

        {error && <div style={{ color: ERROR, fontSize: 12, marginTop: 8 }}>{error}</div>}

        <button
          onClick={analyze}
          disabled={analyzing}
          style={{ width: "100%", marginTop: 18, padding: "13px", background: analyzing ? BORDER : ACCENT, border: "none", borderRadius: 8, fontFamily: "inherit", fontSize: 14, fontWeight: 600, color: analyzing ? MUTED : ACCENT_TEXT, cursor: analyzing ? "not-allowed" : "pointer" }}>
          {analyzing ? "Analyzing your style…" : "Save My Style & Start"}
        </button>

        <div style={{ marginTop: 12, fontSize: 12, color: MUTED, textAlign: "center" }}>
          Don't have an example? Just write 2-3 sentences the way you'd normally open an email.
        </div>
      </div>
    </div>
  );
}

// ── STYLE VIEWER MODAL ────────────────────────────────────────────────────────
function StyleViewer({ profile, onUpdate, onClose }: { profile: StyleProfile; onUpdate: (p: StyleProfile) => void; onClose: () => void }) {
  const [sample, setSample] = useState(profile.writingSample);
  const [additionalSample, setAdditionalSample] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [showEditExamples, setShowEditExamples] = useState(false);
  const [activeSection, setActiveSection] = useState<"style" | "samples" | "history">("style");

  const reanalyze = async () => {
    setAnalyzing(true);
    try {
      const combinedSample = additionalSample.trim()
        ? `${sample}\n\n---\n\n${additionalSample.trim()}`
        : sample;
      const raw = await callClaude([{
        role: "user",
        content: `Analyze this person's writing style from their email sample. Extract: tone (formal/casual/warm/direct), typical length, how they open emails, how they sign off, what they lead with, any distinctive phrases or patterns.

Name: ${profile.repName}
Their writing sample:
---
${combinedSample}
---
${profile.editExamples.length > 0 ? `\nThey have also edited AI drafts. Their edits show:\n${profile.editExamples.slice(-5).join("\n---\n")}` : ""}

Return a concise style guide (3-5 sentences) that can be used to write future emails that sound exactly like them. Be specific about patterns you notice.`
      }]);
      onUpdate({ ...profile, writingSample: combinedSample, extractedStyle: raw });
      onClose();
    } catch {
      setAnalyzing(false);
    }
  };

  const clearEditHistory = () => {
    if (confirm(`Clear all ${profile.editExamples.length} saved edit examples? The style guide will stay, but future drafts won't benefit from learned edits.`)) {
      onUpdate({ ...profile, editExamples: [] });
    }
  };

  const sectionStyle = (id: string) => ({
    padding: "7px 14px", fontSize: 12, fontFamily: "inherit", border: "none", cursor: "pointer" as const,
    background: activeSection === id ? SURFACE : "transparent",
    color: activeSection === id ? TEXT : MUTED,
    fontWeight: activeSection === id ? 600 : 400,
    borderRadius: 6,
  });

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(16,18,26,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, backdropFilter: "blur(4px)" }}>
      <div style={{ background: SURFACE, borderRadius: 14, padding: 32, maxWidth: 520, width: "90%", boxShadow: "0 20px 60px rgba(0,0,0,0.15)", maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: ACCENT, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Writing Style</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: TEXT, marginBottom: 16 }}>{profile.repName}</div>

        {/* Section tabs */}
        <div style={{ display: "flex", background: BG, borderRadius: 8, padding: 3, marginBottom: 20, gap: 2 }}>
          <button style={sectionStyle("style")} onClick={() => setActiveSection("style")}>Style Guide</button>
          <button style={sectionStyle("samples")} onClick={() => setActiveSection("samples")}>Writing Samples</button>
          <button style={{ ...sectionStyle("history"), display: "flex", alignItems: "center", gap: 5 }} onClick={() => setActiveSection("history")}>
            Edit History
            {profile.editExamples.length > 0 && (
              <span style={{ background: SUCCESS, color: "#fff", borderRadius: 10, padding: "1px 6px", fontSize: 10, fontWeight: 700 }}>{profile.editExamples.length}</span>
            )}
          </button>
        </div>

        {activeSection === "style" && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 500, color: TEXT_SECONDARY, marginBottom: 8 }}>How Claude understands your writing style:</div>
            <div style={{ fontSize: 13, color: TEXT_SECONDARY, lineHeight: 1.7, padding: "14px 16px", background: "rgba(20,118,216,0.05)", borderRadius: 8, border: `1px solid rgba(20,118,216,0.15)`, whiteSpace: "pre-wrap" }}>
              {profile.extractedStyle}
            </div>
            {profile.editExamples.length > 0 && (
              <div style={{ marginTop: 12, fontSize: 12, color: SUCCESS, display: "flex", alignItems: "center", gap: 6 }}>
                ✓ Also informed by {profile.editExamples.length} saved edit{profile.editExamples.length > 1 ? "s" : ""} — switch to Edit History to review
              </div>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
              <button onClick={onClose} style={{ flex: 1, padding: "11px", background: "transparent", border: `1px solid ${BORDER}`, borderRadius: 8, fontFamily: "inherit", fontSize: 13, color: TEXT_SECONDARY, cursor: "pointer" }}>
                Close
              </button>
            </div>
          </div>
        )}

        {activeSection === "samples" && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 500, color: TEXT_SECONDARY, marginBottom: 6 }}>Current writing sample</div>
            <textarea
              value={sample}
              onChange={e => setSample(e.target.value)}
              style={{ width: "100%", background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: "10px 14px", color: TEXT, fontFamily: "inherit", fontSize: 13, outline: "none", resize: "vertical", minHeight: 100, boxSizing: "border-box", lineHeight: 1.65 }}
            />
            <div style={{ fontSize: 12, fontWeight: 500, color: TEXT_SECONDARY, marginBottom: 6, marginTop: 16 }}>
              Add more writing <span style={{ color: MUTED, fontWeight: 400 }}>(optional — paste another email or message in your voice)</span>
            </div>
            <textarea
              value={additionalSample}
              onChange={e => setAdditionalSample(e.target.value)}
              placeholder={"Paste another email you've written…"}
              style={{ width: "100%", background: BG, border: `1px solid ${additionalSample ? ACCENT : BORDER}`, borderRadius: 8, padding: "10px 14px", color: TEXT, fontFamily: "inherit", fontSize: 13, outline: "none", resize: "vertical", minHeight: 80, boxSizing: "border-box", lineHeight: 1.65 }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button onClick={onClose} style={{ flex: 1, padding: "11px", background: "transparent", border: `1px solid ${BORDER}`, borderRadius: 8, fontFamily: "inherit", fontSize: 13, color: TEXT_SECONDARY, cursor: "pointer" }}>
                Cancel
              </button>
              <button onClick={reanalyze} disabled={analyzing} style={{ flex: 2, padding: "11px", background: analyzing ? BORDER : ACCENT, border: "none", borderRadius: 8, fontFamily: "inherit", fontSize: 13, fontWeight: 600, color: analyzing ? MUTED : ACCENT_TEXT, cursor: analyzing ? "not-allowed" : "pointer" }}>
                {analyzing ? "Updating style…" : additionalSample.trim() ? "Add Sample & Reanalyze" : "Reanalyze My Style"}
              </button>
            </div>
          </div>
        )}

        {activeSection === "history" && (
          <div>
            {profile.editExamples.length === 0 ? (
              <div style={{ padding: "40px 0", textAlign: "center" }}>
                <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.2 }}>✏️</div>
                <div style={{ fontSize: 13, color: MUTED }}>No edits saved yet. When you edit a draft or follow-up, those changes are saved here to improve future emails.</div>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 12, color: TEXT_SECONDARY, marginBottom: 12 }}>
                  Claude has learned from <strong>{profile.editExamples.length}</strong> edit{profile.editExamples.length !== 1 ? "s" : ""}. The {Math.min(profile.editExamples.length, 5)} most recent are applied when writing new emails. Up to 20 edits are stored — new ones rotate out the oldest.
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
                  <button
                    onClick={() => setShowEditExamples(!showEditExamples)}
                    style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, color: showEditExamples ? ACCENT : INFO, padding: "4px 0", textAlign: "left" }}>
                    {showEditExamples ? "▾ Hide examples" : `▸ View ${profile.editExamples.length} saved example${profile.editExamples.length > 1 ? "s" : ""}`}
                  </button>
                  {showEditExamples && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 320, overflowY: "auto" }}>
                      {profile.editExamples.map((ex, i) => (
                        <div key={i} style={{ background: BG, borderRadius: 8, padding: "12px 14px", border: `1px solid ${BORDER}` }}>
                          <div style={{ fontSize: 10, fontWeight: 600, color: ACCENT, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>Edit {i + 1}</div>
                          <div style={{ fontSize: 12, color: TEXT_SECONDARY, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{ex}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  onClick={clearEditHistory}
                  style={{ fontSize: 12, color: MUTED, background: "none", border: `1px solid ${BORDER}`, borderRadius: 7, padding: "8px 14px", cursor: "pointer", fontFamily: "inherit" }}>
                  Clear edit history
                </button>
              </>
            )}
            <div style={{ marginTop: 20 }}>
              <button onClick={onClose} style={{ width: "100%", padding: "11px", background: "transparent", border: `1px solid ${BORDER}`, borderRadius: 8, fontFamily: "inherit", fontSize: 13, color: TEXT_SECONDARY, cursor: "pointer" }}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── SEGMENT VIEWER MODAL ──────────────────────────────────────────────────────
function SegmentViewer({ profile, onUpdate, onClose }: { profile: StyleProfile; onUpdate: (p: StyleProfile) => void; onClose: () => void }) {
  const parsedSeg = parseSegment(profile.segmentFocus || "");
  const [segTypes, setSegTypes] = useState(parsedSeg.types);
  const [segExamples, setSegExamples] = useState(parsedSeg.examples);
  const [segTravel, setSegTravel] = useState(parsedSeg.travel);
  // Track discoveryEnabled in local state so Save always reads the current value
  // (not the prop, which may not have updated yet if toggle and Save are clicked quickly)
  const [discoveryOn, setDiscoveryOn] = useState(profile.discoveryEnabled ?? false);

  const fieldStyle = (val: string) => ({
    width: "100%", background: SURFACE, border: "none", borderRadius: 6,
    padding: "8px 10px", color: TEXT, fontFamily: "inherit", fontSize: 12,
    outline: "none", resize: "vertical" as const, boxSizing: "border-box" as const, lineHeight: 1.6,
  });

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(16,18,26,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, backdropFilter: "blur(4px)" }}>
      <div style={{ background: SURFACE, borderRadius: 14, padding: 32, maxWidth: 520, width: "90%", boxShadow: "0 20px 60px rgba(0,0,0,0.15)", maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: ACCENT, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Segment Focus</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: TEXT, marginBottom: 4 }}>{profile.repName}</div>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 20, lineHeight: 1.5 }}>
          This drives your batch search. The more specific you are, the more accurate and tailored your results will be.
        </div>

        {!profile.segmentFocus && (
          <div style={{ marginBottom: 16, padding: "9px 12px", background: "rgba(253,75,35,0.06)", border: `1px solid rgba(253,75,35,0.25)`, borderRadius: 7, fontSize: 11, color: ACCENT, lineHeight: 1.5 }}>
            ⚡ Not set yet — batch search is returning generic results. Fill this in to get industry-specific org discovery.
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ background: BG, borderRadius: 8, padding: "14px", border: `1px solid ${segTypes.trim() ? ACCENT : BORDER}` }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: TEXT, marginBottom: 3 }}>1. Target org types & categories</div>
            <div style={{ fontSize: 11, color: MUTED, marginBottom: 8 }}>What kinds of organizations do you go after? List the categories.</div>
            <textarea
              value={segTypes}
              onChange={e => setSegTypes(e.target.value)}
              placeholder={"e.g. TMS platforms, fleet payment companies, trucking associations & GPOs, factoring companies, trucking apps/load boards, equipment leasing, motorcoach operators\n\nOr: SMERF associations — social, military, educational, religious, fraternal groups"}
              style={{ ...fieldStyle(segTypes), minHeight: 80 }}
            />
          </div>

          <div style={{ background: BG, borderRadius: 8, padding: "14px", border: `1px solid ${segExamples.trim() ? ACCENT : BORDER}` }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: TEXT, marginBottom: 3 }}>2. Named examples</div>
            <div style={{ fontSize: 11, color: MUTED, marginBottom: 8 }}>List 5–10 real companies that are perfect targets in your segment.</div>
            <textarea
              value={segExamples}
              onChange={e => setSegExamples(e.target.value)}
              placeholder={"e.g. Trimble, Samsara, OOIDA, RTS Financial, TruckerPath, APEX Capital, ATA, NASTC, TCS, Big Rig Savings\n\nOr: American Legion, NAACP, Knights of Columbus, National FFA Organization, Phi Beta Sigma"}
              style={{ ...fieldStyle(segExamples), minHeight: 60 }}
            />
          </div>

          <div style={{ background: BG, borderRadius: 8, padding: "14px", border: `1px solid ${segTravel.trim() ? ACCENT : BORDER}` }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: TEXT, marginBottom: 3 }}>3. Why Engine is the right fit</div>
            <div style={{ fontSize: 11, color: MUTED, marginBottom: 8 }}>What makes these orgs a strong Engine partner? What's the value prop and partnership angle that lands best with them?</div>
            <textarea
              value={segTravel}
              onChange={e => setSegTravel(e.target.value)}
              placeholder={"e.g. Fleet and trucking companies are ideal because Engine is the only hotel platform built for fleets — WEX/EFS acceptance, truck-friendly search, real-time P&L per driver. The pitch is a complete lodging solution they can offer their driver network, not just a discount.\n\nOr: SMERF associations are ideal because Engine becomes a member benefit — preferred hotel rates for events plus referral revenue back to the org. It's a value-add for members, not just another vendor."}
              style={{ ...fieldStyle(segTravel), minHeight: 80 }}
            />
          </div>
        </div>

        {/* Daily Discovery toggle */}
        <div style={{ marginTop: 20, padding: "14px 16px", background: BG, borderRadius: 10, border: `1px solid ${BORDER}` }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: TEXT, marginBottom: 2 }}>⚡ Daily Discovery</div>
              <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.5 }}>
                Auto-find 3 new SMERF orgs each morning at 6am ET — research, contact, and draft waiting in your Follow-Ups tab.
              </div>
            </div>
            <button
              onClick={() => setDiscoveryOn(prev => !prev)}
              style={{
                flexShrink: 0, marginLeft: 16, width: 44, height: 24, borderRadius: 12, border: "none", cursor: "pointer",
                background: discoveryOn ? SUCCESS : BORDER,
                position: "relative", transition: "background 0.2s",
              }}>
              <span style={{
                position: "absolute", top: 3, left: discoveryOn ? 23 : 3,
                width: 18, height: 18, borderRadius: "50%", background: "#fff",
                transition: "left 0.2s", display: "block",
              }} />
            </button>
          </div>
          {discoveryOn && (
            <div style={{ marginTop: 8, fontSize: 11, color: SUCCESS, fontWeight: 600 }}>
              ✓ Active — drafts will appear in your Follow-Ups tab each morning
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "11px", background: "transparent", border: `1px solid ${BORDER}`, borderRadius: 8, fontFamily: "inherit", fontSize: 13, color: TEXT_SECONDARY, cursor: "pointer" }}>
            Cancel
          </button>
          <button
            onClick={() => { onUpdate({ ...profile, segmentFocus: formatSegment(segTypes, segExamples, segTravel), discoveryEnabled: discoveryOn }); onClose(); }}
            style={{ flex: 2, padding: "11px", background: ACCENT, border: "none", borderRadius: 8, fontFamily: "inherit", fontSize: 13, fontWeight: 600, color: ACCENT_TEXT, cursor: "pointer" }}>
            Save Segment Focus
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Scout org card — actionable result ───────────────────────────────────────
function ScoutOrgCard({ r, onGoToDraft, SURFACE, SURFACE_TINT, BG, BORDER, TEXT, TEXT_SECONDARY, MUTED, ACCENT, INDIGO, INDIGO_BG, SUCCESS }: {
  r: { id: string; org_name: string; org_type: string; website: string; research: string; contact_name: string; contact_title: string; contact_email: string; subject: string; body: string; inPipeline?: boolean };
  onGoToDraft: () => void;
  SURFACE: string; SURFACE_TINT: string; BG: string; BORDER: string; TEXT: string; TEXT_SECONDARY: string; MUTED: string; ACCENT: string; INDIGO: string; INDIGO_BG: string; SUCCESS: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyDraft = () => {
    const text = `Subject: ${r.subject}\n\n${r.body}`;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, overflow: "hidden" }}>
      {/* Header row */}
      <div style={{ padding: "10px 12px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: TEXT, letterSpacing: "-0.01em" }}>{r.org_name}</div>
            <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
              {r.org_type}{r.website ? <> · <a href={r.website} target="_blank" rel="noreferrer" style={{ color: INDIGO }}>{r.website.replace(/^https?:\/\/(www\.)?/, "")}</a></> : null}
            </div>
          </div>
          {r.inPipeline
            ? <span style={{ fontSize: 10, background: INDIGO_BG, color: INDIGO, padding: "2px 8px", borderRadius: 99, flexShrink: 0, fontWeight: 500 }}>In pipeline</span>
            : <span style={{ fontSize: 10, background: "#ECFDF5", color: SUCCESS, padding: "2px 8px", borderRadius: 99, flexShrink: 0, fontWeight: 500 }}>Added</span>
          }
        </div>

        {/* Research snippet */}
        {r.research && (
          <div style={{ fontSize: 11, color: TEXT_SECONDARY, lineHeight: 1.55, marginBottom: 8, borderLeft: `2px solid ${BORDER}`, paddingLeft: 8 }}>
            {r.research.slice(0, 160)}{r.research.length > 160 ? "…" : ""}
          </div>
        )}

        {/* Contact chip */}
        {r.contact_name && (
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
            <span style={{ fontSize: 10, color: TEXT_SECONDARY, background: BG, border: `1px solid ${BORDER}`, padding: "2px 8px", borderRadius: 5 }}>
              {r.contact_name}{r.contact_title ? ` · ${r.contact_title}` : ""}
            </span>
            {r.contact_email && (
              <span style={{ fontSize: 10, color: INDIGO, background: INDIGO_BG, border: `1px solid ${BORDER}`, padding: "2px 8px", borderRadius: 5 }}>{r.contact_email}</span>
            )}
          </div>
        )}

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            onClick={() => setExpanded(e => !e)}
            style={{ fontSize: 11, padding: "5px 10px", borderRadius: 6, border: `1px solid ${expanded ? INDIGO : BORDER}`, background: expanded ? INDIGO_BG : BG, color: expanded ? INDIGO : TEXT_SECONDARY, cursor: "pointer", fontFamily: "inherit", fontWeight: 500 }}>
            {expanded ? "Hide draft ↑" : "View draft ↓"}
          </button>
          <button
            onClick={copyDraft}
            style={{ fontSize: 11, padding: "5px 10px", borderRadius: 6, border: `1px solid ${BORDER}`, background: copied ? "#ECFDF5" : BG, color: copied ? SUCCESS : TEXT_SECONDARY, cursor: "pointer", fontFamily: "inherit", fontWeight: 500 }}>
            {copied ? "Copied ✓" : "Copy email"}
          </button>
          <button
            onClick={onGoToDraft}
            style={{ fontSize: 11, padding: "5px 10px", borderRadius: 6, border: `1px solid ${INDIGO}`, background: INDIGO, color: "#fff", cursor: "pointer", fontFamily: "inherit", fontWeight: 500 }}>
            Go to draft →
          </button>
        </div>
      </div>

      {/* Expanded draft panel */}
      {expanded && r.body && (
        <div style={{ borderTop: `1px solid ${BORDER}`, background: SURFACE_TINT, padding: "10px 14px" }}>
          <div style={{ fontSize: 10, fontWeight: 500, color: MUTED, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Subject</div>
          <div style={{ fontSize: 12, fontWeight: 500, color: TEXT, marginBottom: 10 }}>{r.subject}</div>
          <div style={{ fontSize: 10, fontWeight: 500, color: MUTED, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Body</div>
          <div style={{ fontSize: 12, color: TEXT_SECONDARY, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>{r.body}</div>
        </div>
      )}
    </div>
  );
}

export default function EngineAgent() {
  const [orgName, setOrgName] = useState("");
  const [orgType, setOrgType] = useState("");
  const [orgContext, setOrgContext] = useState("");
  const [batchMode, setBatchMode] = useState(false);
  const [tab, setTab] = useState("contacts");
  const [sideNav, setSideNav] = useState<"outreach" | "reports" | "research" | "settings" | "search">("outreach");
  const [running, setRunning] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [sent, setSent] = useState<SentItem[]>([]);
  const [logs, setLogs] = useState<{ msg: string; cls: string }[]>([]);
  const [status, setStatus] = useState({ msg: "Enter an org name and run the workflow", cls: "" });
  const [styleProfile, setStyleProfile] = useState<StyleProfile | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [showStyleViewer, setShowStyleViewer] = useState(false);
  const [showSegmentViewer, setShowSegmentViewer] = useState(false);
  const [reportEntries, setReportEntries] = useState<ReportEntry[]>([]);
  const [waveNumber, setWaveNumber] = useState(1);
  const [reportSubTab, setReportSubTab] = useState<"log" | "summary" | "followups">("log");
  // ── Orchestrator state ────────────────────────────────────────────────────
  const [orchRunId, setOrchRunId] = useState<string | null>(null);
  const [orchProgress, setOrchProgress] = useState<{ total: number; completed: number } | null>(null);
  const [useParallelMode, setUseParallelMode] = useState(true);
  // Pre-drafted follow-ups loaded from Supabase (written by the cron agent)
  interface PreDraftEntry { id: string; contact_name: string; title: string; email: string; organization: string; stage: string; smerf_category: string; follow_up_due: string | null; follow_up_2_due: string | null; follow_up_3_due: string | null; }
  interface PreDraft { id: string; entry_id: string; fu_num: number; subject: string; body: string; rep_name: string; entry: PreDraftEntry | null; }
  const [preDrafts, setPreDrafts] = useState<PreDraft[]>([]);
  const [preDraftsLoaded, setPreDraftsLoaded] = useState(false);
  const [deployStatus, setDeployStatus] = useState<"idle" | "deploying" | "done" | "error">("idle");
  // Auto-discovered orgs with pre-drafted emails (from daily discovery cron)
  interface AutoDraft { id: string; rep_name: string; org_name: string; org_type: string; contact_name: string; contact_title: string; contact_email: string; contact_source: string; contact_email_verified: boolean; subject: string; subject_b: string; body: string; research: string; website: string; status: string; created_at: string; dismiss_reason?: string; }
  const [autoDrafts, setAutoDrafts] = useState<AutoDraft[]>([]);
  const [autoDraftsLoaded, setAutoDraftsLoaded] = useState(false);
  // Inline email editing for discovered auto-drafts (cron often can't find an email)
  const [editingAdEmail, setEditingAdEmail] = useState<string | null>(null);
  const [adEmailText, setAdEmailText] = useState("");
  const saveAdEmail = async (id: string) => {
    const email = adEmailText.trim();
    if (!email) return;
    await fetch("/api/discover", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, contact_email: email }) });
    setAutoDrafts(prev => prev.map(d => d.id === id ? { ...d, contact_email: email, contact_source: "Manual", contact_email_verified: true } : d));
    setEditingAdEmail(null);
    setAdEmailText("");
  };
  const [discoveryAll, setDiscoveryAll] = useState<AutoDraft[]>([]);
  const [discoveryAllLoaded, setDiscoveryAllLoaded] = useState(false);
  const [repView, setRepView] = useState<"mine" | "all">("mine");
  const [reportPeriod, setReportPeriod] = useState<"today" | "week" | "all">("week");
  const [generatingFollowUp, setGeneratingFollowUp] = useState<string | null>(null);
  const [followUpPreview, setFollowUpPreview] = useState<{ entry: ReportEntry; subject: string; body: string; gmailUrl: string; fuNum: 1 | 2 | 3 } | null>(null);
  const [followUpEditedBody, setFollowUpEditedBody] = useState("");
  const [preDraftIdInModal, setPreDraftIdInModal] = useState<string | null>(null);
  const [showImportModal, setShowImportModal] = useState<"reports" | "generate" | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importPreviewEntries, setImportPreviewEntries] = useState<ReportEntry[] | null>(null);
  const [importRepName, setImportRepName] = useState("");
  const [uploadedOrgs, setUploadedOrgs] = useState<{name:string;type:string;contacts:{name:string;title:string;company:string;email:string;source:string}[]}[]>([]);
  const [uploadedEntries, setUploadedEntries] = useState<ReportEntry[]>([]);
  const [uploadFileName, setUploadFileName] = useState("");
  const [listMode, setListMode] = useState(false);
  const [editingDraft, setEditingDraft] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [editingEmail, setEditingEmail] = useState<number | null>(null);
  const [emailEditText, setEmailEditText] = useState("");
  const [expandedResearch, setExpandedResearch] = useState<number | null>(null);
  const [logSearch, setLogSearch] = useState("");
  const [logFilter, setLogFilter] = useState<"all" | "overdue" | "week" | "duplicates" | DealStage>("all");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // AI Chat
  interface ChatOrgResult {
    id: string; org_name: string; org_type: string; website: string;
    research: string; contact_name: string; contact_title: string;
    contact_email: string; subject: string; body: string; inPipeline?: boolean;
  }
  interface ChatMessage {
    id: string;
    role: "user" | "assistant";
    text: string;
    intent?: "discover" | "pipeline" | "draft" | "mixed";
    stats?: { label: string; value: number | string }[];
    orgs?: ChatOrgResult[];
    actions?: { label: string; prompt: string }[];
    loading?: boolean;
  }
  interface ChatThread { id: string; title: string; updatedAt: string; }
  const [chatInput, setChatInput] = useState("");
  const [chatRunning, setChatRunning] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatThreadId, setChatThreadId] = useState<string | null>(null);
  const [chatThreads, setChatThreads] = useState<ChatThread[]>([]);
  // Research & Pitch
  interface PitchBrief {
    companySnapshot: { name: string; industry: string; size: string; locations: string; description: string; website: string };
    partnershipFit: { score: number; tier: "Strong" | "Potential" | "Low"; signals: string[] };
    distributionPower: { networkSize: string; networkType: string; events: string[]; existingPrograms: string[] };
    engineValueProps: { headline: string; bullets: string[] }[];
    pitchAngles: { angle: string; why: string; openingLine: string }[];
    talkingPoints: string[];
    crossbeamSignals: { partnerName: string; overlapType: string }[];
    recentNews: { headline: string; date: string }[];
    engineAngle: string;
  }
  const BRIEFS_KEY = "engine-partner-briefs-v1";
  interface SavedBrief {
    id: string;
    company: string;
    domain: string;
    brief: PitchBrief;
    savedAt: string;
    repName: string;
  }
  const [pitchCompany, setPitchCompany] = useState("");
  const [pitchDomain, setPitchDomain] = useState("");
  const [pitchNotes, setPitchNotes] = useState("");
  const [pitchLoading, setPitchLoading] = useState(false);
  const [pitchBrief, setPitchBrief] = useState<PitchBrief | null>(null);
  const [pitchError, setPitchError] = useState("");
  const [exportingBrief, setExportingBrief] = useState(false);
  const [savedBriefs, setSavedBriefs] = useState<SavedBrief[]>([]);
  const [activeBriefId, setActiveBriefId] = useState<string | null>(null);

  // Load saved briefs from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(BRIEFS_KEY);
      if (raw) setSavedBriefs(JSON.parse(raw));
    } catch {}
  }, []);

  // ── Orchestrator polling ──────────────────────────────────────────────────
  const processedOrgsRef = useRef(new Set<string>());
  useEffect(() => {
    if (!orchRunId) return;
    processedOrgsRef.current = new Set();
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/orchestrate?runId=${orchRunId}`);
        if (!res.ok) return;
        const data = await res.json();
        setOrchProgress({ total: data.total, completed: data.completed });

        // Process newly completed org tasks as they stream in
        const currentWave = waveNumber;
        const repName = styleProfile?.repName || "";
        (data.tasks || []).forEach((task: { orgName: string; orgType: string; drafts: { contact: Contact & { emailVerified?: boolean; source?: string }; subject: string; subjectB?: string; body: string }[]; research: string; website?: string }) => {
          if (processedOrgsRef.current.has(task.orgName)) return;
          processedOrgsRef.current.add(task.orgName);

          const newEntries: ReportEntry[] = [];
          const newDrafts: Draft[] = [];
          task.drafts.forEach((d, idx) => {
            const entryId = `orch-${Date.now()}-${task.orgName.replace(/\s+/g, "")}-${idx}`;
            newEntries.push({
              id: entryId, repName, wave: currentWave,
              smerfCategory: categorizeSmerf(task.orgType),
              organization: task.orgName, contactName: d.contact.name,
              title: d.contact.title, email: d.contact.email,
              subjectLine: d.subject, dateSent: null, status: "Pending",
              stage: "Prospecting" as DealStage,
              followUpDue: null, followUpSent: false,
              followUp2Due: null, followUp2Sent: false,
              followUp3Due: null, followUp3Sent: false, notes: "",
            });
            newDrafts.push({
              to: d.contact.name, email: d.contact.email,
              subject: d.subject, subjectB: d.subjectB,
              body: d.body, sentAt: null,
              research: task.research, orgType: task.orgType,
              company: task.orgName, contactTitle: d.contact.title,
              reportId: entryId,
              emailVerified: d.contact.emailVerified ?? false,
              contactSource: d.contact.source || "",
            });
          });
          setDrafts(prev => [...prev, ...newDrafts]);
          setReportEntries(prev => [...prev, ...newEntries]);
          setContacts(prev => [...prev, ...task.drafts.map(d => ({ name: d.contact.name, title: d.contact.title, company: task.orgName, email: d.contact.email, source: d.contact.source || "", orgWebsite: task.website || "" }))]);
          if (newEntries.length) {
            fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(newEntries) }).catch(() => {});
          }
          addLog(`✓ ${task.orgName} — ${task.drafts.length} draft${task.drafts.length !== 1 ? "s" : ""} ready`, "ok");
        });

        if (data.status === "done") {
          clearInterval(interval);
          setOrchRunId(null);
          setOrchProgress(null);
          setRunning(false);
          const count = processedOrgsRef.current.size;
          setStatus({ msg: `Done! ${count} org${count !== 1 ? "s" : ""} processed in parallel.`, cls: "ok" });
          setStep(2, "done"); setStep(3, "done"); setStep(4, "done");
        }
      } catch { /* ignore poll errors */ }
    }, 2500);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orchRunId]);

  // ── Load pre-drafted follow-ups from cron agent ───────────────────────────
  const loadPreDrafts = useCallback(async () => {
    try {
      const repParam = styleProfile?.repName ? `?repName=${encodeURIComponent(styleProfile.repName)}` : "";
      const res = await fetch(`/api/followups${repParam}`);
      if (!res.ok) return;
      const { drafts } = await res.json();
      setPreDrafts(drafts || []);
      setPreDraftsLoaded(true);
    } catch { /* silently fail */ }
  }, [styleProfile?.repName]);

  // Auto-load pre-drafts when the Follow-Ups tab is opened
  useEffect(() => {
    if (reportSubTab === "followups" && !preDraftsLoaded) {
      loadPreDrafts();
    }
  }, [reportSubTab, preDraftsLoaded, loadPreDrafts]);

  const loadAutoDrafts = useCallback(async () => {
    try {
      const repName = styleProfile?.repName;
      if (!repName) return;
      const res = await fetch(`/api/discover?rep=${encodeURIComponent(repName)}&status=pending`);
      if (!res.ok) return;
      const { drafts } = await res.json();
      setAutoDrafts(drafts || []);
      setAutoDraftsLoaded(true);
    } catch { /* silently fail */ }
  }, [styleProfile?.repName]);

  // Auto-load discovered drafts when Follow-Ups tab is opened
  useEffect(() => {
    if (reportSubTab === "followups" && !autoDraftsLoaded) {
      loadAutoDrafts();
    }
  }, [reportSubTab, autoDraftsLoaded, loadAutoDrafts]);

  const loadDiscoveryAll = useCallback(async () => {
    try {
      const repName = styleProfile?.repName;
      if (!repName) return;
      const [pendingRes, sentRes, dismissedRes] = await Promise.all([
        fetch(`/api/discover?rep=${encodeURIComponent(repName)}&status=pending`),
        fetch(`/api/discover?rep=${encodeURIComponent(repName)}&status=sent`),
        fetch(`/api/discover?rep=${encodeURIComponent(repName)}&status=dismissed`),
      ]);
      const [p, s, d] = await Promise.all([pendingRes.json(), sentRes.json(), dismissedRes.json()]);
      setDiscoveryAll([...(p.drafts || []), ...(s.drafts || []), ...(d.drafts || [])]);
      setDiscoveryAllLoaded(true);
    } catch { /* silently fail */ }
  }, [styleProfile?.repName]);

  useEffect(() => {
    if (reportSubTab === "summary" && !discoveryAllLoaded) {
      loadDiscoveryAll();
    }
  }, [reportSubTab, discoveryAllLoaded, loadDiscoveryAll]);

  const saveBrief = (brief: PitchBrief, company: string, domain: string) => {
    const id = `${Date.now()}-${company.replace(/\s+/g, "-").toLowerCase()}`;
    const entry: SavedBrief = {
      id, company: brief.companySnapshot.name || company,
      domain, brief, savedAt: new Date().toISOString(),
      repName: styleProfile?.repName || "",
    };
    setSavedBriefs(prev => {
      // Replace if same company already saved, otherwise prepend
      const existing = prev.findIndex(b => b.company.toLowerCase() === entry.company.toLowerCase());
      const updated = existing >= 0
        ? [{ ...entry, id: prev[existing].id }, ...prev.filter((_, i) => i !== existing)]
        : [entry, ...prev];
      try { localStorage.setItem(BRIEFS_KEY, JSON.stringify(updated)); } catch {}
      return updated;
    });
    return id;
  };

  const exportBriefPDF = (brief: PitchBrief) => {
    const rep = styleProfile?.repName || "Engine BD";
    const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const tierColor = brief.partnershipFit.tier === "Strong" ? "#009262" : brief.partnershipFit.tier === "Potential" ? "#1476D8" : "#9E9E9E";

    const section = (title: string, content: string) =>
      `<div class="section"><div class="section-title">${title}</div>${content}</div>`;

    const bullets = (items: string[], color = "#10121A") =>
      items.map(i => `<div class="bullet"><span class="bullet-dot">•</span><span style="color:${color}">${i}</span></div>`).join("");

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${brief.companySnapshot.name} — Engine Partner Brief</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; font-size: 11pt; color: #10121A; background: #fff; }
  .page { max-width: 750px; margin: 0 auto; padding: 48px 56px; }
  .header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 10px; border-bottom: 1px solid #E8E5E0; margin-bottom: 28px; }
  .header-brand { font-size: 9pt; color: #9E9E9E; }
  .header-brand span { color: #FD4B23; font-weight: 700; }
  .company-name { font-size: 26pt; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 4px; }
  .company-meta { font-size: 10pt; color: #616368; margin-bottom: 3px; }
  .company-url { font-size: 10pt; color: #1476D8; margin-bottom: 14px; }
  .tier-row { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
  .tier-badge { font-size: 10pt; font-weight: 700; padding: 3px 14px; border-radius: 12px; }
  .tier-score { font-size: 10pt; color: #9E9E9E; }
  .section { margin-bottom: 20px; }
  .section-title { font-size: 9pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #10121A; border-bottom: 1px solid #E8E5E0; padding-bottom: 5px; margin-bottom: 10px; }
  .about-text { font-size: 10.5pt; line-height: 1.65; color: #10121A; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 32px; }
  .info-row { display: flex; gap: 8px; margin-bottom: 4px; font-size: 10pt; }
  .info-label { width: 100px; color: #616368; font-weight: 700; flex-shrink: 0; }
  .bullet { display: flex; gap: 8px; margin-bottom: 4px; font-size: 10.5pt; line-height: 1.5; }
  .bullet-dot { color: #FD4B23; flex-shrink: 0; }
  .signal-dot { color: #009262; flex-shrink: 0; }
  .pitch-block { border-left: 3px solid #FD4B23; padding-left: 12px; margin-bottom: 14px; }
  .pitch-rec { font-size: 8pt; font-weight: 700; color: #FD4B23; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 3px; }
  .pitch-name { font-size: 11pt; font-weight: 700; margin-bottom: 3px; }
  .pitch-why { font-size: 10pt; color: #616368; margin-bottom: 6px; }
  .opening { font-size: 10pt; font-style: italic; background: #FFF4F1; border-left: 3px solid #FD4B23; padding: 6px 10px; margin-top: 4px; }
  .opening-label { font-style: normal; font-weight: 700; color: #FD4B23; }
  .tp-row { display: flex; gap: 8px; margin-bottom: 6px; font-size: 10.5pt; line-height: 1.5; }
  .tp-num { color: #FD4B23; font-weight: 700; flex-shrink: 0; width: 16px; }
  .vp-headline { font-size: 11pt; font-weight: 700; color: #FD4B23; margin: 10px 0 4px; }
  .cb-box { background: rgba(20,118,216,0.05); border: 1px solid rgba(20,118,216,0.2); border-radius: 4px; padding: 8px 12px; margin-bottom: 6px; font-size: 10.5pt; }
  .footer { display: flex; justify-content: space-between; border-top: 1px solid #E8E5E0; padding-top: 10px; margin-top: 32px; font-size: 8.5pt; color: #9E9E9E; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { padding: 32px 40px; }
    .pitch-block, .opening, .cb-box { break-inside: avoid; }
    .section { break-inside: avoid; }
    @page { margin: 0.6in; size: letter; }
  }
  .print-btn { position: fixed; bottom: 24px; right: 24px; background: #FD4B23; color: #fff; border: none; border-radius: 8px; padding: 12px 24px; font-family: Arial, sans-serif; font-size: 13px; font-weight: 700; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
  @media print { .print-btn { display: none; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">Save as PDF</button>
<div class="page">
  <div class="header">
    <div class="header-brand"><span>Engine</span> Partner Brief</div>
    <div class="header-brand">${today} · Confidential</div>
  </div>

  <div class="company-name">${brief.companySnapshot.name}</div>
  ${[brief.companySnapshot.industry, brief.companySnapshot.size, brief.companySnapshot.locations].filter(Boolean).length
    ? `<div class="company-meta">${[brief.companySnapshot.industry, brief.companySnapshot.size, brief.companySnapshot.locations].filter(Boolean).join("  ·  ")}</div>` : ""}
  ${brief.companySnapshot.website ? `<div class="company-url">${brief.companySnapshot.website}</div>` : ""}
  <div class="tier-row">
    <span class="tier-badge" style="color:${tierColor};background:${tierColor}18">${brief.partnershipFit.tier} Partner Fit</span>
    <span class="tier-score">Score: ${brief.partnershipFit.score}/100</span>
  </div>

  ${brief.companySnapshot.description ? section("About", `<div class="about-text">${brief.companySnapshot.description}</div>`) : ""}

  <div class="info-grid">
    <div>
      ${brief.companySnapshot.industry ? `<div class="info-row"><span class="info-label">Industry</span><span>${brief.companySnapshot.industry}</span></div>` : ""}
      ${brief.companySnapshot.size ? `<div class="info-row"><span class="info-label">Size</span><span>${brief.companySnapshot.size}</span></div>` : ""}
      ${brief.companySnapshot.locations ? `<div class="info-row"><span class="info-label">Locations</span><span>${brief.companySnapshot.locations}</span></div>` : ""}
    </div>
    <div>
      ${brief.distributionPower.networkType && brief.distributionPower.networkType !== "Unknown" ? `<div class="info-row"><span class="info-label">Network type</span><span>${brief.distributionPower.networkType}</span></div>` : ""}
      ${brief.distributionPower.networkSize && brief.distributionPower.networkSize !== "Unknown" ? `<div class="info-row"><span class="info-label">Est. network</span><span>${brief.distributionPower.networkSize}</span></div>` : ""}
    </div>
  </div>

  ${brief.partnershipFit.signals.length ? section("Partnership signals",
    brief.partnershipFit.signals.map(s => `<div class="bullet"><span class="signal-dot">✓</span><span>${s}</span></div>`).join("")) : ""}

  ${(brief.distributionPower.events.length || brief.distributionPower.existingPrograms.length) ? section("Distribution power",
    `${brief.distributionPower.events.length ? `<div class="info-row" style="margin-bottom:6px"><span class="info-label">Events</span><span>${brief.distributionPower.events.join(", ")}</span></div>` : ""}
     ${brief.distributionPower.existingPrograms.length ? `<div class="info-row"><span class="info-label">Programs</span><span>${brief.distributionPower.existingPrograms.join(", ")}</span></div>` : ""}`) : ""}

  ${brief.crossbeamSignals.length ? section("Crossbeam — warm paths",
    brief.crossbeamSignals.map(s => `<div class="cb-box"><strong>${s.partnerName}</strong> — ${s.overlapType}</div>`).join("")) : ""}

  ${brief.engineValueProps.length ? section("Engine value props — tailored",
    brief.engineValueProps.map(vp =>
      `<div class="vp-headline">${vp.headline}</div>${bullets(vp.bullets, "#616368")}`).join("")) : ""}

  ${brief.pitchAngles.length ? section("Pitch angles",
    brief.pitchAngles.map((pa, i) =>
      `<div class="pitch-block" style="border-left-color:${i === 0 ? "#FD4B23" : "#E8E5E0"}">
        ${i === 0 ? `<div class="pitch-rec">★ Recommended</div>` : ""}
        <div class="pitch-name">${pa.angle}</div>
        <div class="pitch-why">${pa.why}</div>
        ${pa.openingLine ? `<div class="opening"><span class="opening-label">Opening line: </span>"${pa.openingLine}"</div>` : ""}
      </div>`).join("")) : ""}

  ${brief.talkingPoints.length ? section("Key talking points",
    brief.talkingPoints.map((tp, i) => `<div class="tp-row"><span class="tp-num">${i + 1}.</span><span>${tp}</span></div>`).join("")) : ""}

  ${brief.recentNews.length ? section("Recent news & timing signals", bullets(brief.recentNews.map(n => typeof n === "string" ? n : `${n.headline}${n.date ? ` (${n.date})` : ""}`))) : ""}

  ${brief.engineAngle ? section("Engine angle", `<div class="about-text">${brief.engineAngle}</div>`) : ""}

  <div class="footer">
    <span>Prepared by ${rep}</span>
    <span>Engine · Confidential</span>
  </div>
</div>
</body></html>`;

    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, "_blank");
    if (win) win.focus();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  // ── ONE-PAGER EXPORT ─────────────────────────────────────────────────────
  const exportOnePager = (brief: PitchBrief) => {
    const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const tierColor = brief.partnershipFit.tier === "Strong" ? "#009262" : brief.partnershipFit.tier === "Potential" ? "#1476D8" : "#9E9E9E";
    const tierBg    = brief.partnershipFit.tier === "Strong" ? "rgba(0,146,98,0.1)" : brief.partnershipFit.tier === "Potential" ? "rgba(20,118,216,0.1)" : "rgba(158,158,158,0.1)";

    // Parse network size string → number
    const parseNet = (s: string): number => {
      if (!s || s === "Unknown") return 10000;
      const c = s.replace(/,/g, "").toUpperCase();
      const m = c.match(/([\d.]+)\s*(K|M|B)?/);
      if (!m) return 10000;
      let n = parseFloat(m[1]);
      if (m[2] === "K") n *= 1_000;
      if (m[2] === "M") n *= 1_000_000;
      if (m[2] === "B") n *= 1_000_000_000;
      return Math.round(n);
    };

    // Format currency
    const fmt = (n: number) => n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `$${Math.round(n / 1000)}K` : `$${n}`;
    const fmtN = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `~${Math.round(n / 1000)}K` : `${n}`;

    const net = parseNet(brief.distributionPower.networkSize);
    const avgBooking = 650;
    const engineTake = 0.05;
    const revShare   = 0.30;

    const trips = [
      Math.max(200,  Math.round(net * 0.005)),
      Math.max(1000, Math.round(net * 0.02)),
      Math.max(5000, Math.round(net * 0.05)),
    ];
    const scenarios = [
      { label: "Year 1 — Early adoption", trips: trips[0] },
      { label: "Year 2 — Scaled rollout",  trips: trips[1] },
      { label: "Full potential",            trips: trips[2] },
    ].map(s => ({
      label: s.label,
      tripsLabel: `~${fmtN(s.trips)} trips`,
      spend:      fmt(s.trips * avgBooking),
      engineRev:  fmt(s.trips * avgBooking * engineTake),
      partnerRev: fmt(s.trips * avgBooking * engineTake * revShare),
    }));

    const signalRows = brief.partnershipFit.signals.slice(0, 6)
      .map(s => `<div class="sig-row"><span class="chk">✓</span><span>${s}</span></div>`).join("");

    const vpRows = brief.engineValueProps.slice(0, 3).map(vp =>
      `<div class="vp-block">
        <div class="vp-head">${vp.headline}</div>
        ${vp.bullets.slice(0, 3).map(b => `<div class="bul"><span class="dot">•</span>${b}</div>`).join("")}
      </div>`).join("");

    const dealRows = scenarios.map((s, i) =>
      `<tr class="${i % 2 === 0 ? "even" : "odd"}${i === scenarios.length - 1 ? " last" : ""}">
        <td class="td-l">${s.label}</td>
        <td>${s.tripsLabel}</td>
        <td>${s.spend}</td>
        <td>${s.engineRev}</td>
        <td>${s.partnerRev}</td>
      </tr>`).join("");

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${brief.companySnapshot.name} — Engine One-Pager</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Arial, sans-serif; font-size: 10.5pt; color: #10121A; background: #fff; }
  .page { max-width: 750px; margin: 0 auto; padding: 40px 52px; }
  .hdr { display:flex; justify-content:space-between; align-items:flex-end; padding-bottom:8px; border-bottom: 1.5px solid #FD4B23; margin-bottom:22px; }
  .hdr-brand { font-size:10pt; }
  .hdr-brand .eng { color:#FD4B23; font-weight:700; }
  .hdr-brand .sub { color:#777; }
  .hdr-right { font-size:8.5pt; color:#777; }
  .co-name { font-size:26pt; font-weight:700; letter-spacing:-0.02em; margin-bottom:3px; }
  .co-meta { font-size:9.5pt; color:#616368; margin-bottom:10px; }
  .tier-row { display:flex; align-items:center; gap:12px; margin-bottom:18px; }
  .tier-badge { font-size:9.5pt; font-weight:700; padding:3px 13px; border-radius:12px; }
  .tier-score { font-size:9.5pt; color:#777; }
  .sec-title { font-size:8pt; font-weight:700; text-transform:uppercase; letter-spacing:0.07em; color:#10121A; border-bottom:1px solid #E0E0E0; padding-bottom:4px; margin-bottom:9px; margin-top:18px; }
  .about { font-size:10pt; line-height:1.6; color:#10121A; margin-bottom:4px; }
  .sig-row { display:flex; gap:8px; margin-bottom:4px; font-size:10pt; line-height:1.5; }
  .chk { color:#FD4B23; flex-shrink:0; font-weight:700; }
  .vp-block { margin-bottom:9px; }
  .vp-head { font-size:10.5pt; font-weight:700; color:#FD4B23; margin-bottom:3px; }
  .bul { display:flex; gap:7px; font-size:10pt; line-height:1.5; margin-bottom:2px; }
  .dot { color:#FD4B23; flex-shrink:0; }
  .deal-intro { font-size:9pt; color:#777; font-style:italic; margin-bottom:8px; }
  table { width:100%; border-collapse:collapse; font-size:8.5pt; margin-top:4px; }
  th { background:#10121A; color:#fff; font-weight:700; padding:6px 8px; text-align:center; }
  th:first-child { text-align:left; }
  td { padding:5px 8px; border-bottom:1px solid #E8E5E0; text-align:center; }
  td.td-l { text-align:left; }
  tr.even td { background:#fff; }
  tr.odd td { background:#F9F9F9; }
  tr.last td { background:#FFF0EC; font-weight:700; }
  .engine-angle { font-size:10pt; line-height:1.6; color:#10121A; }
  .footer { display:flex; justify-content:flex-end; border-top:1px solid #E0E0E0; padding-top:8px; margin-top:24px; font-size:8pt; color:#777; }
  .print-btn { position:fixed; bottom:24px; right:24px; background:#FD4B23; color:#fff; border:none; border-radius:8px; padding:11px 22px; font-family:Arial,sans-serif; font-size:13px; font-weight:700; cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,0.15); }
  @media print { .print-btn { display:none; } body { -webkit-print-color-adjust:exact; print-color-adjust:exact; } @page { margin:0.55in; size:letter; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">Save as PDF</button>
<div class="page">
  <div class="hdr">
    <div class="hdr-brand"><span class="eng">Engine</span><span class="sub"> Partner One-Pager</span></div>
    <div class="hdr-right">${today} · Confidential</div>
  </div>

  <div class="co-name">${brief.companySnapshot.name}</div>
  <div class="co-meta">${[brief.companySnapshot.industry, brief.companySnapshot.size, brief.companySnapshot.locations].filter(Boolean).join("  ·  ")}</div>
  <div class="tier-row">
    <span class="tier-badge" style="color:${tierColor};background:${tierBg}">${brief.partnershipFit.tier} Partner Fit</span>
    <span class="tier-score">Score: ${brief.partnershipFit.score}/100</span>
  </div>

  ${brief.companySnapshot.description ? `<div class="sec-title">About</div><div class="about">${brief.companySnapshot.description}</div>` : ""}

  <div class="sec-title">Partnership Signals</div>
  ${signalRows}

  <div class="sec-title">Engine Value Props — Tailored</div>
  ${vpRows}

  <div class="sec-title">Deal Size Estimate</div>
  <div class="deal-intro">Estimated based on ${brief.distributionPower.networkSize || "network size"} at 0.5%–5% booking penetration · $650 avg booking · 5% Engine take rate · 30% partner rev share</div>
  <table>
    <thead><tr>
      <th>Scenario</th><th>Annual Bookings</th><th>Gross Spend</th><th>Engine Revenue</th><th>Partner Rev Share</th>
    </tr></thead>
    <tbody>${dealRows}</tbody>
  </table>

  ${brief.engineAngle ? `<div class="sec-title">Engine Angle</div><div class="engine-angle">${brief.engineAngle}</div>` : ""}

  <div class="footer">Engine · Confidential</div>
</div>
</body></html>`;

    const blob = new Blob([html], { type: "text/html" });
    const url  = URL.createObjectURL(blob);
    const win  = window.open(url, "_blank");
    if (win) win.focus();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  // ── END ONE-PAGER ─────────────────────────────────────────────────────────

  const deleteBrief = (id: string) => {
    setSavedBriefs(prev => {
      const updated = prev.filter(b => b.id !== id);
      try { localStorage.setItem(BRIEFS_KEY, JSON.stringify(updated)); } catch {}
      return updated;
    });
    if (activeBriefId === id) { setPitchBrief(null); setActiveBriefId(null); }
  };

  const loadSavedBrief = (saved: SavedBrief) => {
    setPitchBrief(saved.brief);
    setPitchCompany(saved.company);
    setPitchDomain(saved.domain);
    setPitchError("");
    setActiveBriefId(saved.id);
  };

  const [pitchLoadingMsg, setPitchLoadingMsg] = useState("Researching…");

  const runPartnerResearch = async () => {
    if (!pitchCompany.trim()) return;
    setPitchLoading(true);
    setPitchBrief(null);
    setPitchError("");
    setActiveBriefId(null);
    setPitchLoadingMsg("Searching the web…");

    // Progress messages shown while polling
    const steps = ["Searching the web…", "Analysing fit signals…", "Building pitch angles…", "Finalising brief…"];
    let stepIdx = 0;
    const progressTimer = setInterval(() => {
      stepIdx = Math.min(stepIdx + 1, steps.length - 1);
      setPitchLoadingMsg(steps[stepIdx]);
    }, 6000);

    try {
      // POST — returns NDJSON: one line containing { brief } or { error }
      const res = await fetch("/api/partner-research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company: pitchCompany.trim(),
          domain: pitchDomain.trim(),
          notes: pitchNotes.trim(),
          segmentFocus: styleProfile?.segmentFocus || "",
          repName: styleProfile?.repName || "",
        }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);

      // Read the NDJSON response — find the line containing the brief
      const text = await res.text();
      let brief: PitchBrief | null = null;
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.error) throw new Error(parsed.error);
          if (parsed.brief) { brief = parsed.brief as PitchBrief; break; }
        } catch (parseErr) {
          // Skip non-JSON lines (Anthropic SSE bytes forwarded to client)
          if (String(parseErr).startsWith("Error:")) throw parseErr;
        }
      }

      if (!brief) throw new Error("Research returned no data — please try again");

      setPitchBrief(brief);
      const newId = saveBrief(brief, pitchCompany.trim(), pitchDomain.trim());
      setActiveBriefId(newId);
    } catch (err) {
      setPitchError(String(err));
    } finally {
      clearInterval(progressTimer);
      setPitchLoading(false);
      setPitchLoadingMsg("Researching…");
    }
  };

  // Crossbeam
  const [cbOverlaps, setCbOverlaps] = useState<Record<string, { partners: string[]; count: number; isCustomer: boolean }>>({});
  const [cbLeaderboard, setCbLeaderboard] = useState<{ name: string; overlaps: number; impact: string; lastActive: string }[]>([]);
  const [cbSuggestions, setCbSuggestions] = useState<{ name: string; domain: string; invite_url?: string }[]>([]);
  const [cbReady, setCbReady] = useState<boolean | null>(null); // null=unknown, true=configured, false=not configured
  const [stepStates, setStepStates] = useState<StepState[]>([
    { label: "Find\nContacts", state: "" },
    { label: "Enrich\nEmails", state: "" },
    { label: "Research\nEach", state: "" },
    { label: "Draft\nEmails", state: "" },
    { label: "Review\n& Send", state: "" },
  ]);

  // Load style profile — Supabase primary, localStorage fallback; load reports from Supabase
  useEffect(() => {
    // First, seed from localStorage so the UI is instant
    let localRepName = "";
    try {
      const saved = localStorage.getItem(STYLE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (!parsed.segmentFocus) parsed.segmentFocus = "";
        setStyleProfile(parsed);
        localRepName = parsed.repName || "";
      }
    } catch { /* ignore */ }
    try {
      const savedWave = localStorage.getItem(WAVE_KEY);
      if (savedWave) setWaveNumber(parseInt(savedWave) || 1);
    } catch { /* ignore */ }
    // Then fetch from Supabase (authoritative) and override if found
    if (localRepName) {
      fetch(`/api/profiles?rep=${encodeURIComponent(localRepName)}`)
        .then(r => r.json())
        .then(({ profile }) => {
          if (profile) {
            setStyleProfile({
              repName:           profile.repName,
              writingSample:     profile.writingSample    || "",
              extractedStyle:    profile.extractedStyle   || "",
              editExamples:      profile.editExamples     || [],
              segmentFocus:      profile.segmentFocus     || "",
              discoveryEnabled:  profile.discoveryEnabled ?? false,
            });
            if (profile.waveNumber) setWaveNumber(profile.waveNumber);
          }
        })
        .catch(() => { /* network error — keep localStorage version */ });
    }
    // Load shared report data from Supabase
    fetch("/api/reports")
      .then(r => r.json())
      .then(data => {
        if (data.entries) {
          // Map snake_case DB fields back to camelCase
          const mapped = data.entries.map((e: Record<string, unknown>) => ({
            id: e.id,
            repName: e.rep_name || "",
            wave: e.wave || 1,
            smerfCategory: e.smerf_category || "",
            organization: e.organization || "",
            contactName: e.contact_name || "",
            title: e.title || "",
            email: e.email || "",
            subjectLine: e.subject_line || "",
            dateSent: e.date_sent || null,
            status: e.status || "Pending",
            stage: (e.stage as DealStage) || "Discovery",
            followUpDue: e.follow_up_due || null,
            followUpSent: e.follow_up_sent || false,
            followUp2Due: e.follow_up_2_due || null,
            followUp2Sent: e.follow_up_2_sent || false,
            followUp3Due: e.follow_up_3_due || null,
            followUp3Sent: e.follow_up_3_sent || false,
            notes: e.notes || "",
            source: (e.source as string) || null,
            repliedAt: (e.replied_at as string) || null,
            replySnippet: (e.reply_snippet as string) || null,
          }));
          setReportEntries(mapped);
        }
      })
      .catch(() => { /* fall back silently */ });
  }, []);

  // Auto-collapse workflow panel when on Reports tab; restore when leaving
  useEffect(() => {
    setSidebarCollapsed(tab === "reports");
    if (tab !== "reports") setLogFilter("all");
    if (tab === "reports") setSideNav("reports");
  }, [tab]);

  const saveStyleProfile = (profile: StyleProfile, wave?: number) => {
    setStyleProfile(profile);
    const effectiveWave = wave ?? waveNumber;
    try { localStorage.setItem(STYLE_KEY, JSON.stringify(profile)); } catch { /* ignore */ }
    try { localStorage.setItem(WAVE_KEY, String(effectiveWave)); } catch { /* ignore */ }
    // Persist to Supabase (fire-and-forget)
    if (profile.repName) {
      fetch("/api/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repName:           profile.repName,
          writingSample:     profile.writingSample,
          extractedStyle:    profile.extractedStyle,
          editExamples:      profile.editExamples,
          segmentFocus:      profile.segmentFocus,
          waveNumber:        effectiveWave,
          discoveryEnabled:  profile.discoveryEnabled ?? false,
        }),
      }).catch(() => { /* network error — local save still succeeded */ });
    }
  };

  // ── Crossbeam helpers ───────────────────────────────────────────────────────
  const cbPost = useCallback(async (action: string, query?: string) => {
    const res = await fetch("/api/crossbeam", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, query }),
    });
    if (!res.ok) {
      if (res.status === 503) { setCbReady(false); return null; }
      return null;
    }
    setCbReady(true);
    return res.json();
  }, []);

  // Load partner leaderboard + suggestions on mount
  useEffect(() => {
    cbPost("dashboard").then(data => {
      if (!data) return;
      if (data.leaderboard) setCbLeaderboard(data.leaderboard);
      if (data.suggestions) setCbSuggestions(data.suggestions);
    });
  }, [cbPost]);

  // Look up Crossbeam overlap for an org (cached)
  const lookupCbOverlap = useCallback(async (orgName: string) => {
    if (!orgName || cbOverlaps[orgName] !== undefined) return;
    // Optimistically mark as "checked" to avoid duplicate calls
    setCbOverlaps(prev => ({ ...prev, [orgName]: { partners: [], count: 0, isCustomer: false } }));
    const data = await cbPost("overlap", orgName);
    if (data?.overlap) {
      setCbOverlaps(prev => ({
        ...prev,
        [orgName]: {
          partners: data.overlap.overlappingPartners || [],
          count: data.overlap.totalOverlaps || 0,
          isCustomer: data.overlap.isCustomer || false,
        },
      }));
    }
  }, [cbOverlaps, cbPost]);

  const saveReportEntries = (entries: ReportEntry[]) => {
    setReportEntries(entries);
    // Persist to Supabase
    if (entries.length > 0) {
      fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entries),
      }).catch(() => { /* ignore */ });
    }
  };

  const patchReportEntry = (id: string, updates: Partial<ReportEntry>) => {
    fetch("/api/reports", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...updates }),
    }).catch(() => { /* ignore */ });
  };

  const cancelledRef = useRef(false);

  const addLog = useCallback((msg: string, cls = "") => setLogs(prev => [...prev, { msg, cls }]), []);
  const setStep = useCallback((idx: number, state: string) =>
    setStepStates(prev => prev.map((s, i) => i === idx ? { ...s, state } : s)), []);

  const resetAll = () => {
    cancelledRef.current = false;
    setContacts([]); setDrafts([]); setLogs([]);
    setStepStates(prev => prev.map(s => ({ ...s, state: "" })));
    setStatus({ msg: "Starting workflow…", cls: "" });
    setEditingDraft(null);
  };

  const handleFileImport = async (file: File, target: "reports" | "generate") => {
    setImportLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/import", { method: "POST", body: fd });
      const data = await res.json();
      if (target === "reports") {
        setImportRepName(styleProfile?.repName || "");
        setImportPreviewEntries(data.entries as ReportEntry[]);
      } else {
        setUploadedOrgs(data.orgs);
        setUploadedEntries(data.entries as ReportEntry[]);
        setUploadFileName(file.name);
        setShowImportModal(null);
      }
    } catch (err) {
      console.error("Import failed", err);
    } finally {
      setImportLoading(false);
    }
  };

  const confirmImportToReports = async () => {
    if (!importPreviewEntries) return;
    setImportLoading(true);
    try {
      const entriesWithRep = importPreviewEntries.map(e => ({ ...e, repName: importRepName || e.repName || "" }));
      await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entriesWithRep),
      });
      setReportEntries(prev => [...prev, ...entriesWithRep]);
      setImportPreviewEntries(null);
      setImportRepName("");
      setShowImportModal(null);
    } catch (err) {
      console.error("Save failed", err);
    } finally {
      setImportLoading(false);
    }
  };

  // ── Parallel batch runner (Orchestrator mode) ─────────────────────────────
  const runWorkflowParallel = async (profile?: StyleProfile) => {
    const activeProfile = profile || styleProfile;
    if (!uploadedOrgs.length || running) return;
    setRunning(true);
    resetAll();
    const thisWave = waveNumber + 1;
    setWaveNumber(thisWave);
    setStep(0, "done"); setStep(1, "active");

    const listSegmentCtx = activeProfile?.segmentFocus
      ? `\n\nSEGMENT CONTEXT: ${activeProfile.segmentFocus.substring(0, 400)}`
      : "";
    const styleContext = activeProfile
      ? `You are ghostwriting for ${activeProfile.repName} at Engine. Match their exact voice from this sample:\n---\n${activeProfile.writingSample}\n---\nStyle: ${activeProfile.extractedStyle}${activeProfile.editExamples.length > 0 ? `\n\nEdits they've made — match this direction:\n${activeProfile.editExamples.slice(-5).join("\n---\n")}` : ""}${listSegmentCtx}`
      : `You are writing outreach for an Engine partnerships rep.`;

    try {
      const res = await fetch("/api/orchestrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgs: uploadedOrgs,
          styleContext,
          repName: activeProfile?.repName || "",
          wave: thisWave,
        }),
      });
      if (!res.ok) throw new Error(`Orchestrator error: ${res.status}`);
      const { runId, total } = await res.json();
      setOrchRunId(runId);
      setOrchProgress({ total, completed: 0 });
      setStep(1, "done"); setStep(2, "active");
      setStatus({ msg: `Running ${total} org${total !== 1 ? "s" : ""} in parallel…`, cls: "" });
      addLog(`Orchestrator started — ${total} orgs running simultaneously`, "ok");
    } catch (err) {
      setRunning(false);
      setOrchRunId(null);
      setOrchProgress(null);
      setStatus({ msg: `Orchestrator failed: ${(err as Error).message}`, cls: "err" });
      addLog("Orchestrator failed — falling back to sequential mode", "err");
      // Fallback to sequential
      runWorkflowFromList(activeProfile ?? undefined);
    }
  };

  const sendChatMessage = async (messageText?: string) => {
    const text = (messageText || chatInput).trim();
    if (!text || chatRunning) return;
    setChatInput("");
    setChatRunning(true);

    const userMsgId = crypto.randomUUID();
    const loadingMsgId = crypto.randomUUID();
    setChatMessages(prev => [
      ...prev,
      { id: userMsgId, role: "user", text },
      { id: loadingMsgId, role: "assistant", text: "", loading: true },
    ]);

    try {
      const repName = styleProfile?.repName || "Darren";
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, threadId: chatThreadId, repName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Chat failed");

      const reply = data.reply;
      if (data.threadId && !chatThreadId) {
        setChatThreadId(data.threadId);
        setChatThreads(prev => [{ id: data.threadId, title: text.slice(0, 55) + (text.length > 55 ? "…" : ""), updatedAt: new Date().toISOString() }, ...prev]);
      }
      setChatMessages(prev => prev.map(m =>
        m.id === loadingMsgId
          ? { id: loadingMsgId, role: "assistant", text: reply.text, intent: reply.intent, stats: reply.stats, orgs: reply.orgs, actions: reply.actions }
          : m
      ));
    } catch (err) {
      setChatMessages(prev => prev.map(m =>
        m.id === loadingMsgId
          ? { id: loadingMsgId, role: "assistant", text: "Something went wrong. Please try again." }
          : m
      ));
      console.error(err);
    } finally {
      setChatRunning(false);
    }
  };

  const handleRunClick = () => {
    if (listMode) {
      if (!uploadedOrgs.length) { alert("Upload a contact list first."); return; }
      if (!styleProfile) { setShowSetup(true); return; }
      if (useParallelMode) { runWorkflowParallel(); } else { runWorkflowFromList(); }
      return;
    }
    if (!styleProfile) { setShowSetup(true); return; }
    runWorkflow();
  };

  const handleStyleComplete = (profile: StyleProfile) => {
    saveStyleProfile(profile);
    setShowSetup(false);
    if (listMode) {
      if (useParallelMode) { runWorkflowParallel(profile); } else { runWorkflowFromList(profile); }
    } else {
      runWorkflow(profile);
    }
  };

  // Save an edited draft as a style example so Claude learns from it
  const saveEditAsStyle = (originalBody: string, editedBody: string) => {
    if (!styleProfile) return;
    const example = `Original draft:\n${originalBody}\n\nHow ${styleProfile.repName} rewrote it:\n${editedBody}`;
    const updated: StyleProfile = {
      ...styleProfile,
      editExamples: [...styleProfile.editExamples, example].slice(-20), // keep last 20
    };
    saveStyleProfile(updated);
  };

  const runWorkflow = async (profile?: StyleProfile) => {
    const activeProfile = profile || styleProfile;
    if (!orgName.trim()) { alert("Enter an org name."); return; }
    if (running) return;
    setRunning(true);
    resetAll();
    const thisWave = waveNumber + 1;
    const newReportEntries: ReportEntry[] = [];

    if (batchMode) {
      try {
        setStep(0, "active");
        setStatus({ msg: `Finding 10 orgs similar to ${orgName}…`, cls: "" });
        addLog(`Discovering orgs similar to ${orgName}…`, "info");

        // Build exclusion list from orgs already in pipeline
        const alreadyContacted = [...new Set(reportEntries.map(e => e.organization).filter(Boolean))];
        const discoverRes = await fetch("/api/discover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            startingOrg: orgName,
            segmentFocus: activeProfile?.segmentFocus || "",
            excludeOrgs: alreadyContacted,
          }),
        });
        const discoverData = discoverRes.ok ? await discoverRes.json() : { orgs: [] };
        const rawOrgList: { name: string; type: string; why?: string }[] = discoverData.orgs?.slice(0, 10) || [];
        if (!rawOrgList.length) throw new Error("Could not find similar organizations — try a different starting org or check your segment focus");

        // Hard client-side dedup: remove any orgs whose name matches one already in the pipeline
        const normalizeOrg = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
        const pipelineOrgNames = new Set(reportEntries.map(e => normalizeOrg(e.organization)));
        const pipelineEmails = new Set(reportEntries.map(e => e.email.toLowerCase().trim()).filter(Boolean));
        const orgList = rawOrgList.filter(org => {
          const norm = normalizeOrg(org.name);
          if (pipelineOrgNames.has(norm)) {
            addLog(`⏭ Skipping ${org.name} — already in your pipeline`, "info");
            return false;
          }
          return true;
        });
        const skippedOrgs = rawOrgList.length - orgList.length;
        if (skippedOrgs > 0) addLog(`Skipped ${skippedOrgs} org${skippedOrgs !== 1 ? "s" : ""} already in your pipeline`, "info");
        if (!orgList.length) throw new Error("All discovered orgs are already in your pipeline — try a different starting org");
        addLog(`Found ${orgList.length} new target orgs (${rawOrgList.length} discovered, ${skippedOrgs} already contacted)`, "ok");
        setStep(0, "done");

        const allContacts: Contact[] = [];
        const allDrafts: Draft[] = [];

        for (let oi = 0; oi < orgList.length; oi++) {
          if (cancelledRef.current) {
            addLog(`⏹ Stopped after ${oi} of ${orgList.length} orgs`, "info");
            break;
          }
          const org = orgList[oi];
          setStatus({ msg: `${oi + 1}/${orgList.length}: Processing ${org.name}…`, cls: "" });
          // Small delay between orgs to avoid hitting API rate limits
          if (oi > 0) await new Promise(r => setTimeout(r, 1500));

          addLog(`Processing ${org.name}…`, "info");

          // Contacts — try web search first, fall back to ZoomInfo, then generated
          let orgContacts: Contact[] = [];
          try {
            addLog(`  Finding contacts at ${org.name}…`, "info");
            const contactsRes = await fetch("/api/contacts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ orgName: org.name, orgType: org.type, domain: (org as { name: string; type: string; domain?: string }).domain || "" }),
            });
            if (contactsRes.ok) {
              const contactsData = await contactsRes.json();
              orgContacts = (contactsData.contacts || []).filter((c: Partial<Contact>) => c.name && c.name.trim() && c.name !== "Unknown");
              const verifiedCount = orgContacts.filter(c => c.emailVerified && c.email).length;
              if (orgContacts.length) addLog(`  Found ${orgContacts.length} contact(s) — ${verifiedCount} with verified email`, verifiedCount > 0 ? "ok" : "info");
            }
          } catch { /* fall through */ }
          // ZoomInfo fallback
          if (!orgContacts.length) {
            try {
              const ziRaw = await lookupZoomInfo(org.name, org.type, "");
              orgContacts = extractContactsFromText(ziRaw, org.name);
            } catch { /* fall through */ }
          }
          // Generated fallback (last resort — names only, no guessed emails)
          if (!orgContacts.length) {
            addLog(`  No real contacts found — generating placeholder names`, "info");
            const genRaw = await callClaude([{ role: "user", content: `Generate 2 realistic decision-maker contacts for "${org.name}" (${org.type}). Use plausible names and titles for this type of org. Do NOT invent email addresses — leave email as empty string. Return ONLY valid JSON: {"contacts":[{"name":"Full Name","title":"Title","company":"${org.name}","email":""}]}` }]);
            const gp = parseJSON(genRaw);
            for (const t of [gp?.contacts, gp?.results]) {
              if (Array.isArray(t) && t.length) { orgContacts = t.map((c: Partial<Contact>) => ({ name: c.name || "Unknown", title: c.title || "Director", company: c.company || org.name, email: "", emailVerified: false, source: "Generated" })); break; }
            }
          }
          if (!orgContacts.length) orgContacts = fallbackContacts(org.name).map(c => ({ ...c, email: "", emailVerified: false }));
          orgContacts = orgContacts.slice(0, 3).map((c: Partial<Contact>) => ({
            name: c?.name || "Unknown",
            title: c?.title || "Director",
            company: c?.company || org.name,
            email: c?.email || "",
            emailVerified: c?.emailVerified ?? (c?.source === "ZoomInfo" ? false : false),
            source: c?.source || "Generated",
          }));
          // Dedup contacts against pipeline by email — skip anyone already contacted
          const freshOrgContacts = orgContacts.filter(c => {
            if (!c.email) return true; // no email = can't match, include
            const alreadyIn = pipelineEmails.has(c.email.toLowerCase().trim());
            if (alreadyIn) addLog(`  ⏭ Skipping ${c.name} — already in pipeline`, "info");
            return !alreadyIn;
          });
          if (freshOrgContacts.length < orgContacts.length) {
            const diff = orgContacts.length - freshOrgContacts.length;
            addLog(`  Skipped ${diff} contact${diff !== 1 ? "s" : ""} at ${org.name} already in your pipeline`, "info");
          }
          orgContacts = freshOrgContacts;
          if (!orgContacts.length) {
            addLog(`  All contacts at ${org.name} already in pipeline — skipping org`, "info");
            continue;
          }
          allContacts.push(...orgContacts);
          setContacts([...allContacts]);

          // Research
          let orgResearch = "";
          try {
            const webRes = await fetch("/api/research", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orgName: org.name, orgType: org.type, orgContext: org.why || "", contactName: "", contactTitle: "" }) });
            if (webRes.ok) {
              const webData = await webRes.json();
              orgResearch = webData?.text || "";
              if (webData?.website) {
                setContacts(prev => prev.map(c => c.company === org.name && !c.orgWebsite ? { ...c, orgWebsite: webData.website } : c));
              }
            }
            if (!orgResearch.trim()) orgResearch = await callClaude([{ role: "user", content: `Research ${org.name} (${org.type}) for an Engine hotel partnership. What events do they run, how large are they, do their people travel regularly for work, and what's the best Engine partnership angle? 4-5 sentences, factual and specific.` }]);
          } catch { /* skip */ }

          // Emails
          const segmentCtx = activeProfile?.segmentFocus
            ? `\n\nSEGMENT CONTEXT (use to sharpen partnership angle): ${activeProfile.segmentFocus.substring(0, 400)}`
            : "";
          const styleContext = activeProfile
            ? `You are ghostwriting for ${activeProfile.repName} at Engine. Match their exact voice from this sample:\n---\n${activeProfile.writingSample}\n---\nStyle: ${activeProfile.extractedStyle}${activeProfile.editExamples.length > 0 ? `\n\nEdits they've made — follow this direction:\n${activeProfile.editExamples.slice(-5).join("\n---\n")}` : ""}${segmentCtx}`
            : `You are writing outreach for an Engine partnerships rep.`;

          for (let ci = 0; ci < orgContacts.length; ci++) {
            const contact = orgContacts[ci];
            const alreadyContacted = orgContacts.slice(0, ci);
            const crossNote = alreadyContacted.length > 0 ? `CROSS-REFERENCE: You also contacted ${alreadyContacted.map(c => `${c.name} (${c.title})`).join(" and ")} at ${org.name} today. Mention this naturally.` : "";

            let draftRaw = "";
            try {
              draftRaw = await callClaude([{ role: "user", content: `${styleContext}\n\nWrite a partnership outreach email to ${contact.name}, ${contact.title} at ${org.name} (${org.type}).\n\nENGINE: Hotel booking platform for organizations whose people travel for work. Say "Engine" never "Engine.com". Hotels only.\nVALUE PROPS (pick the most relevant for this org type):\n- If fleet/trucking: drivers need hotels on the road — Engine is the only platform built for fleets, with WEX/EFS card acceptance and truck-friendly search\n- If association/GPO: preferred hotel rates for member events + member hotel benefit + referral revenue for the org\n- If tech platform/TMS: embed hotel booking into their existing workflow — dispatchers book rooms alongside loads\n- If factoring/payment: hotel as the next spend category they can advance cash for\n${orgResearch ? `\nRESEARCH: ${orgResearch}` : ""}\n${crossNote}\nROLE: ${contact.title} — angle the pitch to what matters most to someone in this role.\nRULES: No em dashes, no "Engine.com", no generic openers, no "I hope this finds you well". Vary structure. Short ask at end.\n\nFormat — use EXACTLY this:\nSUBJECT_A: [curiosity/question style subject — make it feel personal, org-specific]\nSUBJECT_B: [value/direct style subject — lead with the benefit or angle]\n\n[email body]` }]);
            } catch (e) { addLog(`Draft failed for ${contact.name}: ${(e as Error).message}`, "err"); }

            const dp = parseDraft(draftRaw);
            const firstName = contact.name.split(" ")[0];
            const emailBody = dp?.body || `Hi ${firstName},\n\nI'm with Engine, a hotel booking platform for ${org.type.toLowerCase()}s.\n\nOpen to 15 minutes?\n\nBest,\n${activeProfile?.repName || ""}`;
            const orgProper = org.name.split(" ").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
            let subject = stripEmDashes(dp?.subject || "");
            const subjectB = dp?.subjectB ? stripEmDashes(dp.subjectB) : undefined;
            if (!subject.trim()) {
              try {
                const sr = await callClaude([{ role: "user", content: `Write a 4-6 word subject line for this cold outreach email to ${contact.name} at ${orgProper}. No em dashes, no exclamation marks, no "partnership" or "opportunity". Just reply with the subject line.\n\n${emailBody}` }]);
                const cleaned = stripEmDashes(sr.trim().replace(/^["']|["']$/g, ""));
                if (cleaned) subject = cleaned;
              } catch { /* keep existing */ }
            }
            if (!subject.trim()) subject = `${orgProper} + Engine`;

            const batchEntryId = `${Date.now()}-${oi}-${ci}`;
            const batchEntry: ReportEntry = {
              id: batchEntryId,
              repName: activeProfile?.repName || "",
              wave: thisWave,
              smerfCategory: categorizeSmerf(org.type),
              organization: contact.company,
              contactName: contact.name,
              title: contact.title,
              email: contact.email,
              subjectLine: subject,
              dateSent: null,
              status: contact.source === "Fallback" ? "Fallback" : "Pending",
              stage: "Prospecting" as DealStage,
              followUpDue: null,
              followUpSent: false,
              followUp2Due: null, followUp2Sent: false,
              followUp3Due: null, followUp3Sent: false,
              notes: "",
            };
            newReportEntries.push(batchEntry);
            allDrafts.push({ to: contact.name, email: contact.email, subject, subjectB, body: emailBody, sentAt: null, research: orgResearch, orgType: org.type, company: contact.company, contactTitle: contact.title, reportId: batchEntryId, emailVerified: contact.emailVerified ?? false, contactSource: contact.source });
            setDrafts([...allDrafts]);
          }
          addLog(`✓ ${org.name} complete`, "ok");
        }

        setStep(1, "done"); setStep(2, "done"); setStep(3, "done"); setStep(4, "done");
        const wasStopped = cancelledRef.current;
        setStatus({ msg: wasStopped
          ? `⏹ Stopped — ${allDrafts.length} draft${allDrafts.length !== 1 ? "s" : ""} saved so far`
          : `✓ ${allDrafts.length} drafts ready across ${orgList.length} orgs`, cls: wasStopped ? "" : "success" });
        // Save whatever was generated (full run or partial stop)
        saveReportEntries([...reportEntries, ...newReportEntries]);
        setWaveNumber(thisWave);
        if (styleProfile) saveStyleProfile(styleProfile, thisWave);
        setTab("drafts");
      } catch (err) {
        addLog("Error: " + (err as Error).message, "err");
        setStatus({ msg: "Error: " + (err as Error).message, cls: "error" });
      } finally {
        setRunning(false);
      }
      return;
    }

    try {
      // ── STEP 1: ZoomInfo Lookup ──────────────────────
      setStep(0, "active");
      setStatus({ msg: "Searching ZoomInfo for real contacts…", cls: "" });
      addLog("Querying ZoomInfo for: " + orgName, "info");

      let finalContacts: Contact[] = [];

      try {
        const ziRaw = await lookupZoomInfo(orgName, orgType, orgContext);
        addLog("ZoomInfo responded", "info");
        finalContacts = extractContactsFromText(ziRaw, orgName);
        if (finalContacts.length > 0) {
          addLog(`✓ Found ${finalContacts.length} real contacts from ZoomInfo`, "ok");
        } else {
          addLog("ZoomInfo returned no contacts — using AI fallback", "info");
        }
      } catch (ziErr) {
        addLog("ZoomInfo lookup failed: " + (ziErr as Error).message, "err");
        addLog("Falling back to AI-generated contacts", "info");
      }

      if (finalContacts.length === 0) {
        // Try web search contacts (reads actual website staff pages) before generating fake ones
        try {
          addLog("Searching website and web sources for real contacts…", "info");
          const urlMatch = orgContext.match(/(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
          const extractedDomain = urlMatch ? urlMatch[1] : "";
          const webContactsRes = await fetch("/api/contacts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orgName, orgType, domain: extractedDomain }),
          });
          if (webContactsRes.ok) {
            const webData = await webContactsRes.json();
            if (webData.contacts?.length > 0) {
              finalContacts = webData.contacts;
              addLog(`✓ Found ${finalContacts.length} contacts from website/web search`, "ok");
            }
          }
        } catch (webErr) {
          addLog("Web contact search failed: " + (webErr as Error).message, "err");
        }
      }

      if (finalContacts.length === 0) {
        if (!finalContacts.length) finalContacts = fallbackContacts(orgName);
        finalContacts = finalContacts.slice(0, 3).map((c: Partial<Contact>) => ({
          name: c?.name || "Unknown", title: c?.title || "Director",
          company: c?.company || orgName, email: c?.email || "", source: "Generated",
        }));
      }

      setStep(0, "done");

      // ── STEP 2: Enrich Emails ────────────────────────
      setStep(1, "active");
      setStatus({ msg: "Enriching emails…", cls: "" });
      const enriched = finalContacts.map(c => {
        if (!c.email) {
          const domain = orgName.toLowerCase().replace(/[^a-z0-9]/g, "") + ".org";
          c.email = c.name.split(" ")[0].toLowerCase() + "@" + domain;
        }
        return c;
      });
      setContacts(enriched);
      setStep(1, "done");

      // ── STEP 3: Research the Org (once, shared across all contacts) ──
      setStep(2, "active");
      setStatus({ msg: `Researching ${orgName} for partnership fit…`, cls: "" });
      addLog(`Researching ${orgName}…`, "info");

      let orgResearch = "";
      try {
        // Try live web search first
        const webRes = await fetch("/api/research", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            orgName, orgType, orgContext,
            contactName: "", contactTitle: "",
          }),
        });
        if (webRes.ok) {
          const webData = await webRes.json();
          orgResearch = webData?.text || "";
        }

        // Fall back to knowledge-based research if web search returned nothing
        if (!orgResearch.trim()) {
          addLog(`Web search empty — using AI knowledge`, "info");
          orgResearch = await callClaude([{
            role: "user",
            content: `Research ${orgName} (${orgType}) for a partnership outreach from Engine, a hotel booking platform.
${orgContext ? `Known context: ${orgContext}` : ""}

Answer these specifically:
1. What does ${orgName} do and who do they serve? How large is their membership or customer base?
2. What events, conferences, or gatherings do they run — how many per year and at what scale?
3. How do they engage with members/customers on an ongoing basis (not one-off)? Annual events, chapter meetings, benefits programs, etc.?
4. Do their members or customers travel for work, events, or participation in ways that involve hotels?
5. What is the most natural entry point for Engine as a partner — group hotel bookings for their events, a member hotel benefit, or both?
6. Any recent news, growth, or new programs worth mentioning?

Be concrete and specific. 5-7 sentences. These are internal notes only.`,
          }]);
        }
        addLog(`✓ Research complete for ${orgName}`, "ok");
      } catch {
        addLog(`Research skipped`, "info");
      }
      setStep(2, "done");

      // All contacts at this org share the same org research
      const contactResearch = enriched.map(() => orgResearch);

      // ── STEP 4: Draft Emails ─────────────────────────
      setStep(3, "active");
      setStatus({ msg: "Drafting personalized emails in your style…", cls: "" });
      const newDrafts: Draft[] = [];

      const styleContext = activeProfile ? `
You are ghostwriting a cold outreach email for ${activeProfile.repName}, a business development rep at Engine. The email must sound exactly like them — not like AI, not like a template.

Here is a real email ${activeProfile.repName} has written. Study the voice, sentence rhythm, length, how they open, how they close, their level of formality, and any signature phrases:

--- START OF ${activeProfile.repName.toUpperCase()}'S REAL EMAIL ---
${activeProfile.writingSample}
--- END OF REAL EMAIL ---

Style analysis: ${activeProfile.extractedStyle}

${activeProfile.editExamples.length > 0 ? `They have also corrected AI drafts. Here is what they changed and how — match this direction:
${activeProfile.editExamples.slice(-5).join("\n---\n")}` : ""}

Your job: write the new email so that if ${activeProfile.repName} read it, they'd think "yes, this sounds like me." Copy their rhythm, not their words.` : `You are writing a cold outreach email for a business development rep at Engine.`;

      for (let ci = 0; ci < enriched.length; ci++) {
        const contact = enriched[ci];
        const research = contactResearch[ci] || "";

        // Cross-contact context: note colleagues already contacted at this org
        const alreadyContacted = enriched.slice(0, ci);
        const crossContactNote = alreadyContacted.length > 0
          ? `CROSS-REFERENCE (mandatory): You already contacted ${alreadyContacted.map(c => `${c.name} (${c.title})`).join(" and ")} at ${orgName} today. In the first paragraph, state this directly: "I also reached out to ${alreadyContacted[0].name} today, but wanted to connect with you given your [their specific role focus]." Do not make this optional — always include it.`
          : "";

        let draftRaw = "";
        try {
          draftRaw = await callClaude([{
            role: "user",
            content: `${styleContext}

Write a partnership outreach email from ${activeProfile?.repName || "the rep"} to:

Name: ${contact.name}
Title: ${contact.title}
Org: ${contact.company} (${orgType})
${orgContext ? `Context: ${orgContext}` : ""}

WHAT ENGINE IS:
Engine is a hotel booking platform. Always say "Engine", never "Engine.com". Hotels only — never mention flights or airlines.

Engine creates value in two ways for partners:
1. Operational tool: preferred hotel rates for the org's own events and group bookings
2. Member/customer benefit + revenue: members get preferred hotel rates when booking through Engine, and the org earns referral revenue on those bookings

WHAT MAKES A GOOD PARTNER (use this to frame the pitch):
A good partner has ongoing, repeat engagement with their members or customers — not one-off transactions. They can naturally introduce Engine into their existing motion (annual events, chapter meetings, benefits programs, newsletters). Their members or customers have real hotel travel volume tied to their work or participation. The best partners see Engine as a value multiplier — not just a referral fee, but a tool that genuinely makes their members' lives easier and their org run better. The pitch is a two-sided value exchange: Engine makes their customers more successful, and the org earns from it.

${research ? `RESEARCH (read this carefully — use the most relevant detail to show you did your homework and to tie the partnership angle to something real and specific about this org):
${research}` : ""}

${crossContactNote}

ROLE LENS — this shapes your angle:
${contact.name} is a ${contact.title}. Before writing, ask: what does someone in this role actually care about day-to-day, and which part of Engine's value is most relevant to their specific pain or goal? A membership lead cares about member value and non-dues revenue. An events or conference person cares about reducing hotel logistics headaches. A CEO or ED cares about org-wide efficiency and new revenue streams. A development director cares about sustainable non-dues income. Don't use the same pitch for all three contacts at this org — each email should lead with the angle that makes the most sense for this person's specific function.

WHAT TO WRITE:
Based on the research and this person's role, identify the single strongest hook. Is it their events workload, their member travel, a revenue gap, a logistics pain? Lead with the one angle most relevant to ${contact.name} specifically — don't list everything Engine does.

WORKING EXAMPLE (match this tone and structure):
"Hi Carley,
I'm with Engine. I also reached out to Stephanie Abisi today, but wanted to connect with you given your development focus.
Engine can work as both an operational tool for Legion events and a member benefit, preferred hotel rates for members, referral revenue for the organization, and a cleaner booking experience across the board. Given how frequently Legion chapters host events and the member travel that comes with that, it feels like a natural fit.
Open to 20 minutes to explore?"

RULES:
- Vary the opening — don't start every email with "I'm with Engine, a hotel booking platform for X." Sometimes lead with the cross-reference, sometimes with a specific observation about the org from research.
- Para 1: Establish you're with Engine and, if applicable, the cross-reference.
- Para 2: The partnership value — use research to make it specific. Show you understand their motion and why Engine fits naturally into it. Tie back to their members, their events, or their revenue opportunity.
- Para 3: Simple, low-pressure ask. "Open to X minutes?" No formal sign-off.
- Length: match the substance. Short if context is thin. Longer if research gives real detail to work with.
- No em dashes (— or –) anywhere in the email. Use commas or new sentences instead.
- No "I hope this finds you well", "I wanted to reach out", "I'm reaching out because"
- Never "Engine.com"
- Sound like ${activeProfile?.repName || "the rep"} based on their writing sample

Write the email in this exact format:
SUBJECT_A: [curiosity/question style subject — personal, org-specific, makes them wonder]
SUBJECT_B: [value/direct style subject — leads with the benefit or specific angle]

[email body]`
          }]);
        } catch (draftErr) {
          addLog(`Draft failed for ${contact.name}: ${(draftErr as Error).message}`, "err");
        }

        const dp = parseDraft(draftRaw);
        const firstName = contact.name.split(" ")[0];
        const emailBody = dp?.body || `Hi ${firstName},\n\nI'm with Engine, a hotel booking platform for ${orgType.toLowerCase()}s.\n\nOpen to 15 minutes to explore the fit?\n\nBest,\n${activeProfile?.repName || ""}`;

        const orgProper = contact.company.split(" ").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
        let subject = stripEmDashes(dp?.subject || "");
        const subjectBSingle = dp?.subjectB ? stripEmDashes(dp.subjectB) : undefined;
        // Only call separate subject API if SUBJECT_A wasn't parsed from the draft
        if (!subject.trim()) {
          try {
            const subjectRaw = await callClaude([{
              role: "user",
              content: `Write a subject line for this cold outreach email.

Email:
---
${emailBody}
---

Recipient: ${contact.name}, ${contact.title} at ${orgProper}

What to write:
- Read the email and write a subject that reflects what it's actually about — the specific angle, the org, the value mentioned
- 4-6 words. Feels like it came from a person.
- Capitalize the org name correctly: "${orgProper}"
- No "rates", "savings", "discount", "opportunity", "partnership", "quick question", "following up", "I wanted to"
- No em dashes, no en dashes, no exclamation marks, no all-caps
- Think: if you received this email, what subject line would make you open it without feeling sold to?

Examples of the right tone (do not copy these — write one specific to this email):
"${orgProper} hotel program"
"${orgProper} conferences and Engine"
"Intro re: ${orgProper} events"
"Hotel block for ${orgProper}?"

Reply with ONLY the subject line. No quotes. No punctuation at the end.`
            }]);
            const cleaned = stripEmDashes(subjectRaw.trim().replace(/^["']|["']$/g, ""));
            if (cleaned) subject = cleaned;
          } catch {
            // subject keeps its value from dp?.subject or falls through to the final fallback below
          }
        }
        // Final fallback if subject is still empty
        if (!subject.trim()) subject = `${orgProper} + Engine`;

        const singleEntryId = `${Date.now()}-${ci}`;
        const singleEntry: ReportEntry = {
          id: singleEntryId,
          repName: activeProfile?.repName || "",
          wave: thisWave,
          smerfCategory: categorizeSmerf(orgType),
          organization: contact.company,
          contactName: contact.name,
          title: contact.title,
          email: contact.email,
          subjectLine: subject,
          dateSent: null,
          status: contact.source === "Fallback" ? "Fallback" : "Pending",
          stage: "Discovery" as DealStage,
          followUpDue: null,
          followUpSent: false,
          followUp2Due: null, followUp2Sent: false,
          followUp3Due: null, followUp3Sent: false,
          notes: "",
        };
        newReportEntries.push(singleEntry);
        newDrafts.push({
          to: contact.name,
          email: contact.email,
          subject,
          subjectB: subjectBSingle,
          body: emailBody,
          sentAt: null,
          research,
          orgType,
          company: contact.company,
          contactTitle: contact.title,
          reportId: singleEntryId,
        });
        addLog("Draft ready for " + contact.name, "ok");
      }

      setDrafts(newDrafts);
      setStep(3, "done");
      setStep(4, "done");
      setStatus({ msg: "✓ Drafts ready — review and send", cls: "success" });
      addLog("Workflow complete", "ok");
      // Save report entries
      saveReportEntries([...reportEntries, ...newReportEntries]);
      setWaveNumber(thisWave);
      if (styleProfile) saveStyleProfile(styleProfile, thisWave);
      setTab("drafts");

    } catch (err) {
      addLog("Error: " + (err as Error).message, "err");
      setStatus({ msg: "Error: " + (err as Error).message, cls: "error" });
    } finally {
      setRunning(false);
    }
  };

  const runWorkflowFromList = async (profile?: StyleProfile) => {
    const activeProfile = profile || styleProfile;
    if (!uploadedOrgs.length || running) return;
    setRunning(true);
    resetAll();
    const thisWave = waveNumber + 1;
    const newReportEntries: ReportEntry[] = [];
    const allContacts: Contact[] = [];
    const allDrafts: Draft[] = [];

    try {
      // Build dedup sets — check both email AND org+name combination
      const existingEmails = new Set(reportEntries.map(e => e.email.toLowerCase().trim()).filter(Boolean));
      const normalizeForDedup = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
      const existingOrgNames = new Set(reportEntries.map(e => normalizeForDedup(e.organization)));
      const existingOrgContactNames = new Set(reportEntries.map(e => `${normalizeForDedup(e.organization)}||${normalizeForDedup(e.contactName)}`));

      setStep(0, "done");
      setStep(1, "active");

      // Filter out contacts already in the pipeline (by email, or by org+name if no email)
      const freshOrgs = uploadedOrgs.map(org => ({
        ...org,
        contacts: org.contacts.filter(c => {
          // Email match — strongest signal
          if (c.email && existingEmails.has(c.email.toLowerCase().trim())) {
            addLog(`Skipping ${c.name} — email already in pipeline`, "info");
            return false;
          }
          // Org + contact name match — catches re-imports of same person without email
          const key = `${normalizeForDedup(c.company || org.name || "")}||${normalizeForDedup(c.name)}`;
          if (existingOrgContactNames.has(key)) {
            addLog(`Skipping ${c.name} at ${c.company || org.name} — already in pipeline`, "info");
            return false;
          }
          return true;
        }),
      })).filter(org => org.contacts.length > 0);

      const skippedCount = uploadedOrgs.reduce((n, o) => n + o.contacts.length, 0) - freshOrgs.reduce((n, o) => n + o.contacts.length, 0);
      if (skippedCount > 0) addLog(`Skipped ${skippedCount} contacts already in your pipeline`, "info");

      if (!freshOrgs.length) {
        setStatus({ msg: "All contacts in this list are already in your pipeline.", cls: "success" });
        setRunning(false);
        return;
      }

      setStatus({ msg: `${freshOrgs.reduce((n, o) => n + o.contacts.length, 0)} new contacts across ${freshOrgs.length} orgs…`, cls: "" });
      freshOrgs.forEach(org => allContacts.push(...org.contacts));
      setContacts([...allContacts]);
      setStep(1, "done");

      const listSegmentCtx = activeProfile?.segmentFocus
        ? `\n\nSEGMENT CONTEXT: ${activeProfile.segmentFocus.substring(0, 400)}`
        : "";
      const styleContext = activeProfile
        ? `You are ghostwriting for ${activeProfile.repName} at Engine. Match their exact voice from this sample:\n---\n${activeProfile.writingSample}\n---\nStyle: ${activeProfile.extractedStyle}${activeProfile.editExamples.length > 0 ? `\n\nEdits they've made — match this direction:\n${activeProfile.editExamples.slice(-5).join("\n---\n")}` : ""}${listSegmentCtx}`
        : `You are writing outreach for an Engine partnerships rep.`;

      for (let oi = 0; oi < freshOrgs.length; oi++) {
        if (cancelledRef.current) {
          addLog(`⏹ Stopped after ${oi} of ${freshOrgs.length} orgs`, "info");
          break;
        }
        const org = freshOrgs[oi];
        setStatus({ msg: `${oi + 1}/${freshOrgs.length}: Processing ${org.name}…`, cls: "" });
        addLog(`Processing ${org.name}…`, "info");

        setStep(2, "active");
        let orgResearch = "";
        try {
          const webRes = await fetch("/api/research", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orgName: org.name, orgType: org.type, orgContext: "", contactName: "", contactTitle: "" }),
          });
          let orgWebsite = "";
          if (webRes.ok) {
            const webData = await webRes.json();
            orgResearch = webData?.text || "";
            orgWebsite = webData?.website || "";
          }
          if (!orgResearch.trim()) {
            orgResearch = await callClaude([{ role: "user", content: `Research ${org.name} (${org.type}) for an Engine hotel partnership. What events do they run, how large is their membership, do members travel, and what is the best partnership angle? 4-5 sentences, factual and specific.` }]);
          }
          // Backfill website onto contacts for this org now that we have it
          if (orgWebsite) {
            setContacts(prev => prev.map(c => c.company === org.name && !c.orgWebsite ? { ...c, orgWebsite } : c));
          }
          addLog(`Research complete for ${org.name}`, "ok");
        } catch { addLog(`Research skipped for ${org.name}`, "info"); }

        setStep(3, "active");
        for (let ci = 0; ci < org.contacts.length; ci++) {
          const contact = org.contacts[ci];
          const alreadyContacted = org.contacts.slice(0, ci);
          const crossNote = alreadyContacted.length > 0
            ? `CROSS-REFERENCE: You also contacted ${alreadyContacted.map(c => `${c.name} (${c.title})`).join(" and ")} at ${org.name} today. Mention this naturally.`
            : "";

          let draftRaw = "";
          try {
            draftRaw = await callClaude([{ role: "user", content: `${styleContext}\n\nWrite a partnership outreach email to ${contact.name}, ${contact.title} at ${org.name} (${org.type}).\n\nENGINE: Hotel booking platform. Say "Engine" never "Engine.com". Hotels only.\nVALUE: 1) Preferred hotel rates for org events 2) Member hotel benefit + referral revenue for the org.\n${orgResearch ? `RESEARCH: ${orgResearch}` : ""}\n${crossNote}\nROLE: ${contact.title} — angle the pitch to what matters most for this role.\nRULES: No em dashes, no generic openers. Short ask at end.\n\nFormat — use EXACTLY this:\nSUBJECT_A: [curiosity/question style subject — personal, org-specific]\nSUBJECT_B: [value/direct style subject — leads with the benefit]\n\n[body]` }]);
          } catch (e) { addLog(`Draft failed for ${contact.name}: ${(e as Error).message}`, "err"); }

          const dp = parseDraft(draftRaw);
          const firstName = contact.name.split(" ")[0];
          const emailBody = dp?.body || `Hi ${firstName},\n\nI'm with Engine, a hotel booking platform.\n\nOpen to 15 minutes?\n\nBest,\n${activeProfile?.repName || ""}`;
          const orgProper = org.name.split(" ").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
          let subject = stripEmDashes(dp?.subject || "");
          const subjectBList = dp?.subjectB ? stripEmDashes(dp.subjectB) : undefined;
          if (!subject.trim()) {
            try {
              const sr = await callClaude([{ role: "user", content: `Write a 4-6 word subject line for this cold outreach email to ${contact.name} at ${orgProper}. No em dashes, no exclamation marks, no "partnership" or "opportunity". Just reply with the subject line.\n\n${emailBody}` }]);
              const cleaned = stripEmDashes(sr.trim().replace(/^["']|["']$/g, ""));
              if (cleaned) subject = cleaned;
            } catch { /* keep existing */ }
          }
          if (!subject.trim()) subject = `${orgProper} + Engine`;

          const entryId = `list-${Date.now()}-${oi}-${ci}`;
          newReportEntries.push({
            id: entryId, repName: activeProfile?.repName || "", wave: thisWave,
            smerfCategory: categorizeSmerf(org.type), organization: contact.company,
            contactName: contact.name, title: contact.title, email: contact.email,
            subjectLine: subject, dateSent: null, status: "Pending",
            stage: "Prospecting" as DealStage, followUpDue: null, followUpSent: false,
            followUp2Due: null, followUp2Sent: false, followUp3Due: null, followUp3Sent: false, notes: "",
          });
          allDrafts.push({ to: contact.name, email: contact.email, subject, subjectB: subjectBList, body: emailBody, sentAt: null, research: orgResearch, orgType: org.type, company: contact.company, contactTitle: contact.title, reportId: entryId, emailVerified: (contact as Contact).emailVerified ?? false, contactSource: contact.source });
          setDrafts([...allDrafts]);
          addLog(`Draft ready for ${contact.name}`, "ok");
        }
        addLog(`${org.name} complete`, "ok");
      }

      setStep(2, "done"); setStep(3, "done"); setStep(4, "done");
      const listWasStopped = cancelledRef.current;
      setStatus({ msg: listWasStopped
        ? `⏹ Stopped — ${allDrafts.length} draft${allDrafts.length !== 1 ? "s" : ""} saved so far`
        : `${allDrafts.length} drafts ready across ${freshOrgs.length} orgs${skippedCount > 0 ? ` (${skippedCount} skipped — already in pipeline)` : ""}`,
        cls: listWasStopped ? "" : "success" });
      saveReportEntries([...reportEntries, ...newReportEntries]);
      setWaveNumber(thisWave);
      if (styleProfile) saveStyleProfile(styleProfile, thisWave);
      setTab("drafts");
    } catch (err) {
      addLog("Error: " + (err as Error).message, "err");
      setStatus({ msg: "Error: " + (err as Error).message, cls: "error" });
    } finally {
      setRunning(false);
    }
  };

  const openInGmail = (d: Draft, i: number, markSent: boolean) => {
    const body = d.edited || d.body;
    // Use selected A/B variant subject, fall back to subject A (default)
    const chosenSubject = d.selectedVariant === "B" && d.subjectB ? d.subjectB : d.subject;
    const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(d.email)}&su=${encodeURIComponent(chosenSubject)}&body=${encodeURIComponent(body)}`;
    window.open(gmailUrl, "_blank");
    if (markSent) {
      const now = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      const today = new Date();
      const todayStr = toISOLocal(today);
      const fu1Str = addDaysISO(today, 5);
      const fu2Str = addDaysISO(today, 9);
      const fu3Str = addDaysISO(today, 15);
      const variantUsed = d.selectedVariant || "A";
      setDrafts(prev => prev.map((dr, idx) => idx === i ? { ...dr, sentAt: now } : dr));
      setSent(prev => [...prev, { to: d.to, email: d.email, subject: chosenSubject, sentAt: now }]);
      addLog("Opened Gmail for " + d.to, "ok");
      setReportEntries(prev => prev.map(entry => {
        if ((d.reportId && entry.id === d.reportId) || entry.email === d.email) {
          patchReportEntry(entry.id, { status: "Sent", dateSent: todayStr, followUpDue: fu1Str, followUp2Due: fu2Str, followUp3Due: fu3Str, subjectVariant: variantUsed });
          return { ...entry, status: "Sent" as const, dateSent: todayStr, followUpDue: fu1Str, followUp2Due: fu2Str, followUp3Due: fu3Str, subjectVariant: variantUsed as "A" | "B" };
        }
        return entry;
      }));
    }
  };

  const updateEntryStage = (entryId: string, stage: DealStage) => {
    setReportEntries(prev => prev.map(e => e.id === entryId ? { ...e, stage } : e));
    patchReportEntry(entryId, { stage });
  };

  const updateEntryNotes = (entryId: string, notes: string) => {
    setReportEntries(prev => prev.map(e => e.id === entryId ? { ...e, notes } : e));
    patchReportEntry(entryId, { notes });
  };

  const generateFollowUp = async (entry: ReportEntry, fuNum: 1 | 2 | 3 = 1) => {
    setGeneratingFollowUp(entry.id);
    try {
      // Pull the original email body and research from the matching draft
      const matchingDraft = drafts.find(d => d.reportId === entry.id) || drafts.find(d => d.email === entry.email);
      const originalEmailBody = matchingDraft?.edited || matchingDraft?.body || "";
      const orgResearch = matchingDraft?.research || "";

      // Style guide
      const styleContext = styleProfile
        ? `Ghostwriting for ${styleProfile.repName} at Engine. Their writing style:\n${styleProfile.extractedStyle}`
        : "Writing for an Engine partnerships rep.";

      // Engine value props — what the partnership actually offers
      const engineContext = `
Engine is a hotel booking platform built for organizations that need to manage group and employee travel. Key partnership value:
- Members/employees book hotels through a branded Engine portal at negotiated rates
- The org gets visibility into all travel spend and duty-of-care tracking
- Engine handles billing centrally — no expense reports, no credit card chaos
- For associations and member orgs: Engine can be a revenue-generating member benefit
- Best fit: orgs running regular events, conventions, or travel programs where multiple people book hotels at the same time and place`;

      // Segment focus from the rep's profile
      const segmentCtx = styleProfile?.segmentFocus
        ? `\nRep's segment focus (use to sharpen the angle):\n${styleProfile.segmentFocus.substring(0, 500)}`
        : "";

      // Contact context
      const contactCtx = `Contact: ${entry.contactName}${entry.title ? `, ${entry.title}` : ""} at ${entry.organization} (${entry.smerfCategory || "org"})`;

      // Notes the rep has added
      const notesCtx = entry.notes ? `\nRep's notes on this contact: ${entry.notes}` : "";

      // Original email for context
      const originalCtx = originalEmailBody
        ? `\nOriginal email sent:\n---\n${originalEmailBody}\n---`
        : `\nOriginal subject line: "${entry.subjectLine}"`;

      // Research gathered about the org
      const researchCtx = orgResearch
        ? `\nOrg research:\n${orgResearch.substring(0, 600)}`
        : "";

      const fuPrompt = fuNum === 1
        ? `Write follow-up #1 to the email above. No reply after 5 days.

Rules:
- 2-3 sentences max. Short, human, no fluff.
- Don't repeat the full pitch — lightly reference what you sent and add ONE new angle or observation based on the org research
- Keep the Engine partnership angle alive — this is still about the hotel booking opportunity, not a generic check-in
- End with a single soft ask (e.g. "Worth a quick call?" or "Would this be on your radar for [event]?")
- No em dashes, no "just following up", no "I hope this finds you well", no "circling back"`

        : fuNum === 2
        ? `Write follow-up #2. Two emails sent already, still no reply after 9 days.

Rules:
- Try a completely different angle from the first two emails — lead with something specific from the org research (an event they run, their member base, a recent news item)
- 2-3 sentences. Show you've done your homework, not just chasing a reply.
- Tie it back to what Engine solves for orgs like theirs
- End with a simple yes/no question to lower the barrier
- No em dashes, no generic openers`

        : `Write a final "breakup" email. Three emails over 15 days, no response.

Rules:
- Warm, not passive-aggressive. One short paragraph.
- Acknowledge they're busy. Leave the door completely open for the future.
- Subtly remind them what the opportunity was so it sticks
- No em dashes, no guilt-tripping, no hard sell`;

      const fullPrompt = `${styleContext}
${engineContext}
${segmentCtx}

${contactCtx}${notesCtx}${originalCtx}${researchCtx}

${fuPrompt}

Format:
SUBJECT: Re: ${entry.subjectLine}

[body]`;

      // Call /api/claude directly — skip the 1.5s pacing sleep used in batch workflows
      const res = await fetch("/api/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: fullPrompt }]
        }),
      });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const raw = (await res.json()).text || "";

      const dp = parseDraft(raw);
      const firstName = entry.contactName.split(" ")[0];
      const body = dp?.body || `Hi ${firstName},\n\nWanted to check back on my previous note. Worth a quick call?\n\n${styleProfile?.repName || ""}`;
      const subject = dp?.subject || `Re: ${entry.subjectLine}`;

      const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(entry.email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      setFollowUpEditedBody(body);
      setFollowUpPreview({ entry, subject, body, gmailUrl, fuNum });
    } catch (err) {
      console.error("Follow-up failed:", err);
    } finally {
      setGeneratingFollowUp(null);
    }
  };

  const nextFollowUp = (entry: ReportEntry): { num: 1 | 2 | 3; due: string; label: string } | null => {
    if (entry.status !== "Sent") return null;
    // If this contact has moved past Prospecting, they're being actively worked — no follow-up needed.
    if (entry.stage !== "Prospecting") return null;
    // If any other contact at this org has moved past Prospecting, the org is engaged —
    // suppress follow-up actions for all contacts there so reps don't double-touch.
    const orgEngaged = reportEntries.some(e =>
      e.id !== entry.id &&
      e.organization === entry.organization &&
      e.stage !== "Prospecting"
    );
    if (orgEngaged) return null;
    if (!entry.followUpSent && entry.followUpDue) return { num: 1, due: entry.followUpDue, label: "Follow-up 1" };
    if (!entry.followUp2Sent && entry.followUp2Due) return { num: 2, due: entry.followUp2Due, label: "Follow-up 2" };
    if (!entry.followUp3Sent && entry.followUp3Due) return { num: 3, due: entry.followUp3Due, label: "Follow-up 3" };
    return null;
  };

  const isOverdue = (entry: ReportEntry) => {
    const next = nextFollowUp(entry);
    if (!next) return false;
    try {
      const due = parseLocalDate(next.due);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      return due < today;
    } catch { return false; }
  };

  const startEditing = (i: number) => {
    setEditingDraft(i);
    setEditText(drafts[i].edited || drafts[i].body);
  };

  const saveEdit = (i: number) => {
    const original = drafts[i].body;
    const edited = editText;
    setDrafts(prev => prev.map((d, idx) => idx === i ? { ...d, edited } : d));
    if (edited !== original) saveEditAsStyle(original, edited);
    setEditingDraft(null);
  };

  const saveEmailEdit = (i: number) => {
    const newEmail = emailEditText.trim();
    if (!newEmail) return;
    // Update the draft
    setDrafts(prev => prev.map((d, idx) => idx === i ? { ...d, email: newEmail, emailVerified: true, contactSource: "Manual" } : d));
    // Update the matching report entry in state and Supabase
    const d = drafts[i];
    setReportEntries(prev => prev.map(entry => {
      if ((d.reportId && entry.id === d.reportId) || entry.email === d.email) {
        patchReportEntry(entry.id, { email: newEmail });
        return { ...entry, email: newEmail };
      }
      return entry;
    }));
    setEditingEmail(null);
    setEmailEditText("");
  };

  return (
    <div style={{ fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", background: BG, color: TEXT, minHeight: "100vh", display: "flex", flexDirection: "column" }}>

      {showSetup && <StyleSetup onComplete={handleStyleComplete} />}
      {showStyleViewer && styleProfile && (
        <StyleViewer
          profile={styleProfile}
          onUpdate={p => { saveStyleProfile(p); }}
          onClose={() => setShowStyleViewer(false)}
        />
      )}
      {showSegmentViewer && styleProfile && (
        <SegmentViewer
          profile={styleProfile}
          onUpdate={p => { saveStyleProfile(p); }}
          onClose={() => setShowSegmentViewer(false)}
        />
      )}

      {/* Follow-up Preview Modal */}
      {followUpPreview && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(16,18,26,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, backdropFilter: "blur(4px)" }}>
          <div style={{ background: SURFACE, borderRadius: 14, padding: 32, maxWidth: 540, width: "90%", boxShadow: "0 20px 60px rgba(0,0,0,0.15)" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: ACCENT, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Follow-up {followUpPreview.fuNum} of 3</div>
            <div style={{ fontSize: 13, color: TEXT_SECONDARY, marginBottom: 4 }}>
              To: <span style={{ color: TEXT, fontWeight: 500 }}>{followUpPreview.entry.contactName}</span> <span style={{ color: MUTED }}>{"<"}{followUpPreview.entry.email}{">"}</span>
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: TEXT, marginBottom: 10, marginTop: 10 }}>{followUpPreview.subject}</div>
            <textarea
              value={followUpEditedBody}
              onChange={e => setFollowUpEditedBody(e.target.value)}
              style={{ width: "100%", background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: "12px 14px", color: TEXT, fontFamily: "inherit", fontSize: 13, lineHeight: 1.7, outline: "none", resize: "vertical", minHeight: 140, boxSizing: "border-box", marginBottom: 6 }}
            />
            {followUpEditedBody !== followUpPreview.body && (
              <div style={{ fontSize: 11, color: SUCCESS, marginBottom: 10, display: "flex", alignItems: "center", gap: 5 }}>
                ✓ Your edits will be saved to your style profile
              </div>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: followUpEditedBody !== followUpPreview.body ? 0 : 10 }}>
              <button
                onClick={() => { setFollowUpPreview(null); setFollowUpEditedBody(""); setPreDraftIdInModal(null); }}
                style={{ flex: 1, padding: "11px", background: "transparent", border: `1px solid ${BORDER}`, borderRadius: 8, fontFamily: "inherit", fontSize: 13, color: TEXT_SECONDARY, cursor: "pointer" }}>
                Discard
              </button>
              <button
                onClick={() => {
                  const finalBody = followUpEditedBody;
                  const finalUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(followUpPreview.entry.email)}&su=${encodeURIComponent(followUpPreview.subject)}&body=${encodeURIComponent(finalBody)}`;
                  window.open(finalUrl, "_blank");
                  if (finalBody !== followUpPreview.body) saveEditAsStyle(followUpPreview.body, finalBody);
                  const fuField = followUpPreview.fuNum === 1 ? { followUpSent: true } : followUpPreview.fuNum === 2 ? { followUp2Sent: true } : { followUp3Sent: true };
                  setReportEntries(prev => prev.map(e => e.id === followUpPreview.entry.id ? { ...e, ...fuField } : e));
                  patchReportEntry(followUpPreview.entry.id, fuField);
                  // Mark the pre-draft as sent if it came from the agent queue
                  if (preDraftIdInModal) {
                    fetch("/api/followups", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: preDraftIdInModal, status: "sent" }) });
                    setPreDrafts(prev => prev.filter(d => d.id !== preDraftIdInModal));
                    setPreDraftIdInModal(null);
                  }
                  setFollowUpPreview(null);
                  setFollowUpEditedBody("");
                }}
                style={{ flex: 2, padding: "11px", background: ACCENT, border: "none", borderRadius: 8, fontFamily: "inherit", fontSize: 13, fontWeight: 600, color: ACCENT_TEXT, cursor: "pointer" }}>
                Open in Gmail & Mark Sent
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import to Reports Modal */}
      {showImportModal === "reports" && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(16,18,26,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, backdropFilter: "blur(4px)" }}>
          <div style={{ background: SURFACE, borderRadius: 14, padding: 32, maxWidth: 460, width: "90%", boxShadow: "0 20px 60px rgba(0,0,0,0.15)" }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: TEXT, marginBottom: 6 }}>Import Contact List</div>
            <div style={{ fontSize: 13, color: TEXT_SECONDARY, marginBottom: 20, lineHeight: 1.6 }}>
              Upload your XLSX or CSV file. Contacts will be added to the Activity Log with status based on Date Sent.
            </div>
            {!importPreviewEntries ? (
              <>
                <label style={{ display: "block", border: `2px dashed ${BORDER}`, borderRadius: 10, padding: "32px 20px", textAlign: "center", cursor: "pointer", background: BG }}>
                  <input type="file" accept=".xlsx,.csv,.xls" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) handleFileImport(f, "reports"); e.target.value = ""; }} />
                  {importLoading ? (
                    <div style={{ fontSize: 13, color: MUTED }}>Parsing file…</div>
                  ) : (
                    <>
                      <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.25 }}>📂</div>
                      <div style={{ fontSize: 13, fontWeight: 500, color: TEXT }}>Click to choose file</div>
                      <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>XLSX, XLS, or CSV · Supports First Name, Last Name, Title, Email, Organization, Category, Date Sent, Follow-Up Due</div>
                    </>
                  )}
                </label>
                <button onClick={() => setShowImportModal(null)} style={{ marginTop: 16, width: "100%", padding: "11px", background: "transparent", border: `1px solid ${BORDER}`, borderRadius: 8, fontFamily: "inherit", fontSize: 13, color: TEXT_SECONDARY, cursor: "pointer" }}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <div style={{ background: "rgba(0,146,98,0.06)", border: `1px solid rgba(0,146,98,0.2)`, borderRadius: 8, padding: "14px 16px", marginBottom: 16 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: SUCCESS }}>{importPreviewEntries.length} contacts ready to import</div>
                  <div style={{ fontSize: 12, color: TEXT_SECONDARY, marginTop: 4 }}>
                    {importPreviewEntries.filter(e => e.status === "Sent").length} already sent · {importPreviewEntries.filter(e => e.status === "Pending").length} pending · all set to Prospecting stage
                  </div>
                </div>

                {/* Rep assignment */}
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: TEXT, marginBottom: 8 }}>Assign to Rep</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {[...new Set([styleProfile?.repName, ...reportEntries.map(e => e.repName)].filter(Boolean) as string[])].map(name => (
                      <button key={name} onClick={() => setImportRepName(name)}
                        style={{ padding: "6px 14px", fontSize: 12, fontWeight: 500, borderRadius: 20, border: `1px solid ${importRepName === name ? ACCENT : BORDER}`, background: importRepName === name ? "rgba(253,75,35,0.08)" : SURFACE, color: importRepName === name ? ACCENT : TEXT_SECONDARY, cursor: "pointer", fontFamily: "inherit" }}>
                        {name}
                      </button>
                    ))}
                    <button onClick={() => setImportRepName("")}
                      style={{ padding: "6px 14px", fontSize: 12, fontWeight: 500, borderRadius: 20, border: `1px solid ${!importRepName ? ACCENT : BORDER}`, background: !importRepName ? "rgba(253,75,35,0.08)" : SURFACE, color: !importRepName ? ACCENT : TEXT_SECONDARY, cursor: "pointer", fontFamily: "inherit" }}>
                      Unassigned
                    </button>
                  </div>
                  {importRepName && <div style={{ fontSize: 11, color: MUTED, marginTop: 6 }}>All {importPreviewEntries.length} contacts will be assigned to {importRepName}</div>}
                </div>
                <div style={{ maxHeight: 200, overflowY: "auto", border: `1px solid ${BORDER}`, borderRadius: 8, marginBottom: 16 }}>
                  {importPreviewEntries.slice(0, 10).map((e, i) => (
                    <div key={i} style={{ padding: "10px 14px", borderBottom: i < Math.min(importPreviewEntries.length - 1, 9) ? `1px solid ${BORDER}` : "none", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: TEXT }}>{e.contactName}</div>
                        <div style={{ fontSize: 11, color: TEXT_SECONDARY }}>{e.organization} · {e.smerfCategory}</div>
                      </div>
                      <div style={{ fontSize: 11, color: e.status === "Sent" ? SUCCESS : MUTED, fontWeight: 500 }}>{e.status}</div>
                    </div>
                  ))}
                  {importPreviewEntries.length > 10 && (
                    <div style={{ padding: "10px 14px", fontSize: 11, color: MUTED }}>+ {importPreviewEntries.length - 10} more…</div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setImportPreviewEntries(null)} style={{ flex: 1, padding: "11px", background: "transparent", border: `1px solid ${BORDER}`, borderRadius: 8, fontFamily: "inherit", fontSize: 13, color: TEXT_SECONDARY, cursor: "pointer" }}>
                    Back
                  </button>
                  <button onClick={confirmImportToReports} disabled={importLoading} style={{ flex: 2, padding: "11px", background: importLoading ? BORDER : ACCENT, border: "none", borderRadius: 8, fontFamily: "inherit", fontSize: 13, fontWeight: 600, color: importLoading ? MUTED : ACCENT_TEXT, cursor: importLoading ? "not-allowed" : "pointer" }}>
                    {importLoading ? "Importing…" : `Import ${importPreviewEntries.length} Contacts`}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Top accent bar */}
      <div style={{ height: 3, background: `linear-gradient(90deg, ${INDIGO}, #a78bfa)`, flexShrink: 0 }} />

      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 24px", height: 52, borderBottom: `1px solid ${BORDER}`, background: SURFACE, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: TEXT, letterSpacing: "-0.025em", fontFamily: "'Inter', sans-serif" }}>Engine</span>
          <span style={{ fontSize: 15, fontWeight: 600, color: INDIGO, letterSpacing: "-0.025em", fontFamily: "'Inter', sans-serif" }}>Agent</span>
          <div style={{ width: 1, height: 14, background: BORDER, margin: "0 2px" }} />
          <span style={{ fontSize: 11, color: MUTED, fontWeight: 400 }}>Partnership prospecting</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {styleProfile && (
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={() => setShowStyleViewer(true)}
                style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 6, padding: "6px 12px", color: TEXT_SECONDARY, fontSize: 12, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6, fontWeight: 500 }}>
                <span style={{ fontSize: 13 }}>✎</span> {styleProfile.repName}'s Style
                {styleProfile.editExamples.length > 0 && <span style={{ background: ACCENT, color: ACCENT_TEXT, borderRadius: 10, padding: "1px 6px", fontSize: 10, fontWeight: 600 }}>{styleProfile.editExamples.length} edits</span>}
              </button>
              <button
                onClick={() => setShowSegmentViewer(true)}
                style={{ background: styleProfile.segmentFocus ? BG : "rgba(253,75,35,0.06)", border: `1px solid ${styleProfile.segmentFocus ? BORDER : "rgba(253,75,35,0.35)"}`, borderRadius: 6, padding: "6px 12px", color: styleProfile.segmentFocus ? TEXT_SECONDARY : ACCENT, fontSize: 12, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6, fontWeight: 500 }}>
                <span style={{ fontSize: 11 }}>◎</span> Segment Focus
                {!styleProfile.segmentFocus && <span style={{ background: ACCENT, color: ACCENT_TEXT, borderRadius: 10, padding: "1px 5px", fontSize: 9, fontWeight: 700 }}>!</span>}
                {styleProfile.segmentFocus && <span style={{ background: SUCCESS, color: "#fff", borderRadius: 10, padding: "1px 5px", fontSize: 9, fontWeight: 700 }}>✓</span>}
              </button>
            </div>
          )}
          {/* Initials avatar */}
          <div style={{ width: 28, height: 28, borderRadius: "50%", background: INDIGO_BG, border: `1px solid ${BORDER}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 600, color: INDIGO, flexShrink: 0, marginLeft: 2 }}>
            DC
          </div>
        </div>
      </header>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* ── Sidebar ── */}
        <div style={{ width: 164, background: SIDEBAR_BG, borderRight: `1px solid ${BORDER}`, display: "flex", flexDirection: "column", padding: "8px 8px", gap: 1, flexShrink: 0, zIndex: 10 }}>
          {/* App label */}
          <div style={{ padding: "8px 8px 12px", borderBottom: `1px solid ${BORDER}`, marginBottom: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: TEXT, letterSpacing: "-0.02em" }}>Engine <span style={{ color: INDIGO }}>Agent</span></div>
            <div style={{ fontSize: 10, color: MUTED, marginTop: 2, fontWeight: 400 }}>Partnership AI</div>
          </div>
          {([
            ["outreach", "✉", "Outreach"],
            ["reports", "📊", "Reports"],
            ["research", "🔍", "Research"],
            ["search", "✦", "Scout"],
          ] as [typeof sideNav, string, string][]).map(([key, icon, label]) => (
            <button
              key={key}
              onClick={() => {
                setSideNav(key);
                if (key === "reports") setTab("reports");
                if (key === "outreach") setTab("contacts");
              }}
              style={{
                width: "100%", padding: "7px 10px 7px 14px", borderRadius: 8, border: "none",
                background: "transparent",
                color: sideNav === key ? INDIGO : TEXT_SECONDARY,
                fontSize: 12, fontWeight: sideNav === key ? 500 : 400,
                cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
                textAlign: "left", transition: "all 0.12s", fontFamily: "inherit",
                position: "relative",
                borderLeft: sideNav === key ? `3px solid ${INDIGO}` : "3px solid transparent",
              }}
            >
              <span style={{ fontSize: 14, flexShrink: 0, opacity: sideNav === key ? 1 : 0.5 }}>{icon}</span>
              {label}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <div style={{ height: 1, background: BORDER, margin: "4px 0" }} />
          <button
            onClick={() => setSideNav("settings")}
            style={{
              width: "100%", padding: "7px 10px 7px 14px", borderRadius: 8, border: "none",
              background: "transparent",
              color: sideNav === "settings" ? INDIGO : TEXT_SECONDARY,
              fontSize: 12, fontWeight: sideNav === "settings" ? 500 : 400,
              cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
              textAlign: "left", fontFamily: "inherit",
              borderLeft: sideNav === "settings" ? `3px solid ${INDIGO}` : "3px solid transparent",
            }}
          >
            <span style={{ fontSize: 14, opacity: sideNav === "settings" ? 1 : 0.5 }}>⚙</span>
            Settings
          </button>
        </div>

        {/* ── AI Chat section ── */}
        {sideNav === "search" && (
          <div style={{ flex: 1, display: "flex", overflow: "hidden", background: BG }}>

            {/* Thread sidebar */}
            <div style={{ width: 200, background: SURFACE, borderRight: `1px solid ${BORDER}`, display: "flex", flexDirection: "column", flexShrink: 0 }}>
              <button
                onClick={() => { setChatMessages([]); setChatThreadId(null); }}
                style={{ margin: 10, padding: "7px 10px", fontSize: 12, background: BG, border: `1px solid ${BORDER}`, borderRadius: 7, cursor: "pointer", color: TEXT_SECONDARY, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}
              >
                <span style={{ fontSize: 16, lineHeight: 1 }}>+</span> New chat
              </button>
              <div style={{ flex: 1, overflow: "auto", padding: "0 8px 8px" }}>
                {chatThreads.length > 0 && (
                  <>
                    <div style={{ fontSize: 10, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: "0.05em", padding: "4px 4px 6px" }}>Recent</div>
                    {chatThreads.slice(0, 12).map(t => (
                      <button
                        key={t.id}
                        onClick={() => setChatThreadId(t.id)}
                        style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 8px", fontSize: 12, color: t.id === chatThreadId ? TEXT : TEXT_SECONDARY, background: t.id === chatThreadId ? BG : "transparent", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", lineHeight: 1.4, marginBottom: 2 }}
                      >
                        {t.title}
                      </button>
                    ))}
                  </>
                )}
                {chatThreads.length === 0 && (
                  <div style={{ padding: "8px 4px", fontSize: 11, color: MUTED, lineHeight: 1.5 }}>
                    Ask anything — find orgs, check your pipeline, or re-draft an email.
                  </div>
                )}
              </div>
            </div>

            {/* Main chat area */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>

              {/* Header */}
              <div style={{ padding: "10px 20px", borderBottom: `1px solid ${BORDER}`, background: SURFACE, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: TEXT }}>Scout</div>
                {chatMessages.length > 0 && chatMessages.some(m => m.intent) && (
                  <span style={{ fontSize: 10, padding: "3px 9px", borderRadius: 99, fontWeight: 600, background: chatMessages.filter(m=>m.intent).slice(-1)[0]?.intent === "pipeline" ? "rgba(59,130,246,0.1)" : chatMessages.filter(m=>m.intent).slice(-1)[0]?.intent === "draft" ? "rgba(234,179,8,0.1)" : "rgba(29,158,117,0.1)", color: chatMessages.filter(m=>m.intent).slice(-1)[0]?.intent === "pipeline" ? "#1d4ed8" : chatMessages.filter(m=>m.intent).slice(-1)[0]?.intent === "draft" ? "#92400e" : "#0F6E56" }}>
                    {chatMessages.filter(m=>m.intent).slice(-1)[0]?.intent}
                  </span>
                )}
              </div>

              {/* Messages */}
              <div style={{ flex: 1, overflow: "auto", padding: "20px", display: "flex", flexDirection: "column", gap: 14 }}>

                {/* Empty state */}
                {chatMessages.length === 0 && (
                  <div style={{ maxWidth: 560, margin: "0 auto", paddingTop: 20 }}>
                    <div style={{ fontSize: 13, color: TEXT_SECONDARY, marginBottom: 16, lineHeight: 1.6 }}>
                      Ask anything about your pipeline or search for new orgs to pitch.
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>Try asking</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {[
                        "Find 5 BGLOs with national conventions I haven't pitched",
                        "Which accounts have gone cold in the last 30 days?",
                        "How many emails have I sent and what's my reply rate?",
                        "Show me all my pending drafts",
                        "Find large religious denominations with annual conferences",
                        "Re-draft my email for Alpha Phi Alpha with a revenue angle",
                      ].map(p => (
                        <button key={p} onClick={() => sendChatMessage(p)}
                          style={{ textAlign: "left", padding: "8px 12px", fontSize: 12, color: TEXT_SECONDARY, background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 7, cursor: "pointer", fontFamily: "inherit" }}>
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Message bubbles */}
                {chatMessages.map(msg => (
                  <div key={msg.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", flexDirection: msg.role === "user" ? "row-reverse" : "row", maxWidth: "100%" }}>
                    {/* Avatar */}
                    <div style={{ width: 28, height: 28, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, marginTop: 2, background: msg.role === "user" ? "rgba(29,158,117,0.15)" : "rgba(99,82,233,0.12)", color: msg.role === "user" ? "#0F6E56" : "#4B39B8" }}>
                      {msg.role === "user" ? (styleProfile?.repName?.[0] || "D") : "S"}
                    </div>

                    {/* Bubble */}
                    <div style={{ background: msg.role === "user" ? BG : SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "10px 14px", maxWidth: "82%", fontSize: 13, lineHeight: 1.6, color: TEXT }}>

                      {/* Loading state */}
                      {msg.loading ? (
                        <div style={{ display: "flex", gap: 4, alignItems: "center", padding: "2px 0" }}>
                          {[0, 0.2, 0.4].map((d, i) => (
                            <span key={i} style={{ width: 5, height: 5, borderRadius: "50%", background: MUTED, display: "inline-block", animation: `spin 0.9s ${d}s infinite` }} />
                          ))}
                        </div>
                      ) : (
                        <>
                          {/* Text */}
                          <div style={{ whiteSpace: "pre-wrap" }}>{msg.text}</div>

                          {/* Stats row */}
                          {msg.stats && msg.stats.length > 0 && (
                            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                              {msg.stats.map((s, i) => (
                                <div key={i} style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: "6px 12px", textAlign: "center", minWidth: 70 }}>
                                  <div style={{ fontSize: 18, fontWeight: 700, color: TEXT }}>{s.value}</div>
                                  <div style={{ fontSize: 10, color: MUTED, marginTop: 1 }}>{s.label}</div>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Org result cards */}
                          {msg.orgs && msg.orgs.length > 0 && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                              {msg.orgs.map(r => (
                                <ScoutOrgCard
                                  key={r.id}
                                  r={r}
                                  onGoToDraft={() => { setSideNav("outreach"); setTab("drafts"); }}
                                  SURFACE={SURFACE} SURFACE_TINT={SURFACE_TINT} BG={BG} BORDER={BORDER}
                                  TEXT={TEXT} TEXT_SECONDARY={TEXT_SECONDARY} MUTED={MUTED}
                                  ACCENT={ACCENT} INDIGO={INDIGO} INDIGO_BG={INDIGO_BG} SUCCESS={SUCCESS}
                                />
                              ))}
                            </div>
                          )}

                          {/* Action buttons */}
                          {msg.actions && msg.actions.length > 0 && (
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                              {msg.actions.map((a, i) => (
                                <button key={i} onClick={() => sendChatMessage(a.prompt)}
                                  style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: `1px solid ${BORDER}`, background: SURFACE, color: TEXT_SECONDARY, cursor: "pointer", fontFamily: "inherit" }}>
                                  {a.label} →
                                </button>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Input area */}
              <div style={{ padding: "12px 16px", borderTop: `1px solid ${BORDER}`, background: SURFACE, flexShrink: 0 }}>
                {/* Suggestion chips — only when no messages */}
                {chatMessages.length === 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                    {["Stalled accounts", "Pending drafts", "Find new orgs", "Pipeline stats"].map(c => (
                      <button key={c} onClick={() => sendChatMessage(c === "Stalled accounts" ? "Which accounts have gone cold in the last 30 days?" : c === "Pending drafts" ? "Show me all my pending drafts" : c === "Find new orgs" ? "Find 5 new SMERF orgs I haven't pitched" : "What is my pipeline status right now?")}
                        style={{ fontSize: 11, padding: "3px 10px", borderRadius: 99, border: `1px solid ${BORDER}`, background: BG, color: TEXT_SECONDARY, cursor: "pointer", fontFamily: "inherit" }}>
                        {c}
                      </button>
                    ))}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <textarea
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChatMessage(); } }}
                    placeholder="Ask anything — find orgs, check pipeline, review drafts…"
                    rows={1}
                    style={{ flex: 1, resize: "none", fontSize: 13, padding: "8px 12px", border: `1px solid ${BORDER}`, borderRadius: 8, background: BG, color: TEXT, fontFamily: "inherit", lineHeight: 1.5, outline: "none" }}
                  />
                  <button
                    onClick={() => sendChatMessage()}
                    disabled={chatRunning || !chatInput.trim()}
                    style={{ width: 36, height: 36, borderRadius: 8, background: (chatRunning || !chatInput.trim()) ? BORDER : ACCENT, border: "none", cursor: (chatRunning || !chatInput.trim()) ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
                  >
                    <span style={{ color: "white", fontSize: 16, lineHeight: 1 }}>↑</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Research & Pitch section ── */}
        {sideNav === "research" && (
          <div style={{ flex: 1, display: "flex", overflow: "hidden", background: BG }}>
            {/* Left panel: search form + saved briefs */}
            <div style={{ width: 300, background: SURFACE, borderRight: `1px solid ${BORDER}`, display: "flex", flexDirection: "column", overflow: "hidden", flexShrink: 0 }}>
              {/* Search form */}
              <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12, borderBottom: `1px solid ${BORDER}` }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: TEXT, marginBottom: 2 }}>Research & Pitch</div>
                  <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.5 }}>Build a partner brief before your call</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: TEXT_SECONDARY, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>Company Name</div>
                  <input value={pitchCompany} onChange={e => setPitchCompany(e.target.value)} onKeyDown={e => e.key === "Enter" && runPartnerResearch()}
                    placeholder="e.g. National Builders Council"
                    style={{ width: "100%", background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: "8px 12px", color: TEXT, fontFamily: "inherit", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: TEXT_SECONDARY, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>Domain <span style={{ fontWeight: 400, color: MUTED, textTransform: "none" }}>(optional)</span></div>
                  <input value={pitchDomain} onChange={e => setPitchDomain(e.target.value)} placeholder="e.g. builders.org"
                    style={{ width: "100%", background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: "8px 12px", color: TEXT, fontFamily: "inherit", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: TEXT_SECONDARY, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>Meeting Notes <span style={{ fontWeight: 400, color: MUTED, textTransform: "none" }}>(optional)</span></div>
                  <textarea value={pitchNotes} onChange={e => setPitchNotes(e.target.value)} rows={3}
                    placeholder="Meeting Thu with their ED. Run 3 conferences/year. Budget-conscious."
                    style={{ width: "100%", background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: "8px 12px", color: TEXT, fontFamily: "inherit", fontSize: 13, outline: "none", resize: "vertical", boxSizing: "border-box" }} />
                </div>
                <button onClick={runPartnerResearch} disabled={pitchLoading || !pitchCompany.trim()}
                  style={{ width: "100%", padding: "10px", background: pitchLoading || !pitchCompany.trim() ? BORDER : ACCENT, border: "none", borderRadius: 8, fontFamily: "inherit", fontSize: 13, fontWeight: 600, color: pitchLoading || !pitchCompany.trim() ? MUTED : ACCENT_TEXT, cursor: pitchLoading || !pitchCompany.trim() ? "not-allowed" : "pointer" }}>
                  {pitchLoading ? pitchLoadingMsg : "Build Partner Brief"}
                </button>
                {pitchError && <div style={{ fontSize: 12, color: ERROR, background: "rgba(229,57,53,0.06)", border: `1px solid rgba(229,57,53,0.15)`, borderRadius: 6, padding: "8px 12px" }}>{pitchError}</div>}
              </div>

              {/* Saved briefs list */}
              <div style={{ flex: 1, overflowY: "auto" }}>
                {savedBriefs.length > 0 && (
                  <div style={{ padding: "12px 16px 6px", fontSize: 10, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    Saved · {savedBriefs.length}
                  </div>
                )}
                {savedBriefs.length === 0 && (
                  <div style={{ padding: "20px 16px", fontSize: 12, color: MUTED, textAlign: "center", lineHeight: 1.6 }}>
                    Researched orgs will appear here. Click any to reload without re-searching.
                  </div>
                )}
                {savedBriefs.map(saved => {
                  const isActive = activeBriefId === saved.id;
                  const tier = saved.brief.partnershipFit.tier;
                  const tierColor = tier === "Strong" ? SUCCESS : tier === "Potential" ? INFO : MUTED;
                  const daysAgo = Math.floor((Date.now() - new Date(saved.savedAt).getTime()) / 86400000);
                  const dateLabel = daysAgo === 0 ? "Today" : daysAgo === 1 ? "Yesterday" : `${daysAgo}d ago`;
                  return (
                    <div key={saved.id}
                      onClick={() => loadSavedBrief(saved)}
                      style={{ padding: "10px 16px", cursor: "pointer", background: isActive ? "rgba(253,75,35,0.04)" : "transparent", borderLeft: `3px solid ${isActive ? ACCENT : "transparent"}`, borderBottom: `1px solid ${BORDER}`, transition: "background 0.1s" }}>
                      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: isActive ? 600 : 500, color: TEXT, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{saved.company}</div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
                            <span style={{ fontSize: 10, fontWeight: 600, color: tierColor, background: `${tierColor}18`, borderRadius: 10, padding: "1px 7px" }}>{tier}</span>
                            <span style={{ fontSize: 11, color: MUTED }}>{dateLabel}</span>
                          </div>
                        </div>
                        <button onClick={e => { e.stopPropagation(); deleteBrief(saved.id); }}
                          style={{ background: "none", border: "none", color: MUTED, cursor: "pointer", fontSize: 14, padding: "0 2px", lineHeight: 1, flexShrink: 0, marginTop: 1 }}
                          title="Remove">×</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Brief output panel */}
            <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
              {pitchLoading && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "60%", gap: 16 }}>
                  <div style={{ fontSize: 32, opacity: 0.2 }}>🔍</div>
                  <div style={{ fontSize: 14, color: TEXT_SECONDARY, textAlign: "center" }}>Researching {pitchCompany}…<br /><span style={{ fontSize: 12, color: MUTED }}>ZoomInfo · Web research · Crossbeam · AI synthesis</span></div>
                </div>
              )}
              {!pitchLoading && !pitchBrief && !pitchError && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "60%", gap: 12, opacity: 0.4 }}>
                  <div style={{ fontSize: 40 }}>📄</div>
                  <div style={{ fontSize: 13, color: MUTED, textAlign: "center" }}>Enter a company name to generate<br />a partner brief</div>
                </div>
              )}
              {pitchBrief && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 780 }}>
                  {/* Header */}
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
                    <div>
                      <div style={{ fontSize: 22, fontWeight: 700, color: TEXT, letterSpacing: "-0.01em" }}>{pitchBrief.companySnapshot.name}</div>
                      <div style={{ fontSize: 13, color: TEXT_SECONDARY, marginTop: 4 }}>
                        {pitchBrief.companySnapshot.industry} · {pitchBrief.companySnapshot.size} · {pitchBrief.companySnapshot.locations}
                      </div>
                      {pitchBrief.companySnapshot.website && <div style={{ fontSize: 12, color: INFO, marginTop: 4 }}>{pitchBrief.companySnapshot.website}</div>}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, flexShrink: 0 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, padding: "4px 14px", borderRadius: 20, background: pitchBrief.partnershipFit.tier === "Strong" ? "rgba(0,146,98,0.1)" : pitchBrief.partnershipFit.tier === "Potential" ? "rgba(20,118,216,0.1)" : "rgba(158,158,158,0.1)", color: pitchBrief.partnershipFit.tier === "Strong" ? SUCCESS : pitchBrief.partnershipFit.tier === "Potential" ? INFO : MUTED }}>
                        {pitchBrief.partnershipFit.tier} Partner Fit
                      </span>
                      <span style={{ fontSize: 11, color: MUTED }}>Score: {pitchBrief.partnershipFit.score}/100</span>
                      <button
                        onClick={() => exportBriefPDF(pitchBrief)}
                        style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", background: ACCENT, border: "none", borderRadius: 8, fontFamily: "inherit", fontSize: 12, fontWeight: 600, color: ACCENT_TEXT, cursor: "pointer", marginTop: 4 }}>
                        ⬇ Download PDF
                      </button>
                      <button
                        onClick={() => exportOnePager(pitchBrief)}
                        style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", background: "transparent", border: `1.5px solid ${ACCENT}`, borderRadius: 8, fontFamily: "inherit", fontSize: 12, fontWeight: 600, color: ACCENT, cursor: "pointer" }}>
                        📄 One-Pager
                      </button>
                    </div>
                  </div>

                  {pitchBrief.companySnapshot.description && (
                    <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 18px" }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: TEXT_SECONDARY, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>About</div>
                      <div style={{ fontSize: 13, color: TEXT, lineHeight: 1.6 }}>{pitchBrief.companySnapshot.description}</div>
                    </div>
                  )}

                  {/* 2-col row: fit signals + distribution */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                    <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 18px" }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: TEXT_SECONDARY, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 10 }}>Partnership Signals</div>
                      {pitchBrief.partnershipFit.signals.map((s, i) => (
                        <div key={i} style={{ fontSize: 12, color: TEXT, display: "flex", gap: 8, marginBottom: 5 }}>
                          <span style={{ color: SUCCESS, flexShrink: 0 }}>✓</span> {s}
                        </div>
                      ))}
                    </div>
                    <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 18px" }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: TEXT_SECONDARY, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>Distribution Power</div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: TEXT, marginBottom: 4 }}>{pitchBrief.distributionPower.networkType}</div>
                      <div style={{ fontSize: 12, color: TEXT_SECONDARY, marginBottom: 8 }}>Estimated network: {pitchBrief.distributionPower.networkSize}</div>
                      {pitchBrief.distributionPower.events.length > 0 && (
                        <div style={{ marginBottom: 6 }}>
                          <div style={{ fontSize: 11, color: MUTED, marginBottom: 3 }}>Events</div>
                          {pitchBrief.distributionPower.events.map((e, i) => <div key={i} style={{ fontSize: 12, color: TEXT }}>• {e}</div>)}
                        </div>
                      )}
                      {pitchBrief.distributionPower.existingPrograms.length > 0 && (
                        <div>
                          <div style={{ fontSize: 11, color: MUTED, marginBottom: 3 }}>Existing programs</div>
                          {pitchBrief.distributionPower.existingPrograms.map((p, i) => <div key={i} style={{ fontSize: 12, color: TEXT }}>• {p}</div>)}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Crossbeam signals */}
                  {pitchBrief.crossbeamSignals.length > 0 && (
                    <div style={{ background: "rgba(20,118,216,0.04)", border: `1px solid rgba(20,118,216,0.15)`, borderRadius: 10, padding: "14px 18px" }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: INFO, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>🤝 Crossbeam — Warm Path Available</div>
                      {pitchBrief.crossbeamSignals.map((s, i) => (
                        <div key={i} style={{ fontSize: 13, color: TEXT, marginBottom: 4 }}><span style={{ fontWeight: 600 }}>{s.partnerName}</span> — {s.overlapType}</div>
                      ))}
                    </div>
                  )}

                  {/* Engine value props */}
                  <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 18px" }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: TEXT_SECONDARY, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 12 }}>Engine Value Props — Tailored</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      {pitchBrief.engineValueProps.map((vp, i) => (
                        <div key={i} style={{ borderLeft: `3px solid ${ACCENT}`, paddingLeft: 14 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: TEXT, marginBottom: 4 }}>{typeof vp.headline === "string" ? vp.headline : String(vp.headline ?? "")}</div>
                          {(Array.isArray(vp.bullets) ? vp.bullets : []).map((b, j) => <div key={j} style={{ fontSize: 12, color: TEXT_SECONDARY, marginBottom: 2 }}>• {typeof b === "string" ? b : String(b ?? "")}</div>)}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Pitch angles */}
                  <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 18px" }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: TEXT_SECONDARY, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 12 }}>Pitch Angles</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                      {pitchBrief.pitchAngles.map((pa, i) => (
                        <div key={i} style={{ padding: "12px 16px", background: i === 0 ? "rgba(253,75,35,0.04)" : BG, border: `1px solid ${i === 0 ? "rgba(253,75,35,0.2)" : BORDER}`, borderRadius: 8 }}>
                          {i === 0 && <div style={{ fontSize: 10, fontWeight: 700, color: ACCENT, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Recommended</div>}
                          <div style={{ fontSize: 13, fontWeight: 600, color: TEXT, marginBottom: 4 }}>{pa.angle}</div>
                          <div style={{ fontSize: 12, color: TEXT_SECONDARY, marginBottom: 8 }}>{pa.why}</div>
                          <div style={{ fontSize: 12, color: INFO, fontStyle: "italic", background: "rgba(20,118,216,0.04)", borderRadius: 6, padding: "8px 12px" }}>"{pa.openingLine}"</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Talking points */}
                  <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 18px" }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: TEXT_SECONDARY, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 10 }}>Key Talking Points</div>
                    {pitchBrief.talkingPoints.map((tp, i) => (
                      <div key={i} style={{ fontSize: 13, color: TEXT, display: "flex", gap: 10, marginBottom: 8, lineHeight: 1.5 }}>
                        <span style={{ color: ACCENT, fontWeight: 700, flexShrink: 0 }}>{i + 1}.</span> {tp}
                      </div>
                    ))}
                  </div>

                  {/* Recent news */}
                  {pitchBrief.recentNews.length > 0 && (
                    <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 18px" }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: TEXT_SECONDARY, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 10 }}>Recent News & Timing Signals</div>
                      {pitchBrief.recentNews.map((n, i) => (
                        <div key={i} style={{ fontSize: 13, color: TEXT, display: "flex", gap: 8, marginBottom: 6 }}>
                          <span style={{ color: MUTED, flexShrink: 0 }}>•</span>
                          <span>{typeof n === "string" ? n : `${n.headline}${n.date ? ` (${n.date})` : ""}`}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Settings section ── */}
        {sideNav === "settings" && (
          <div style={{ flex: 1, padding: 32, overflowY: "auto", background: BG }}>
            <div style={{ maxWidth: 560 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: TEXT, marginBottom: 20 }}>Style & Profile Settings</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {styleProfile ? (
                  <>
                    <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 20 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: TEXT, marginBottom: 4 }}>{styleProfile.repName}</div>
                      <div style={{ fontSize: 12, color: TEXT_SECONDARY, marginBottom: 14 }}>
                        {styleProfile.editExamples.length} style edits · {styleProfile.segmentFocus ? "Segment focus set" : "No segment focus yet"}
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button onClick={() => setShowStyleViewer(true)} style={{ flex: 1, padding: "9px", background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, fontFamily: "inherit", fontSize: 12, fontWeight: 500, color: TEXT_SECONDARY, cursor: "pointer" }}>
                          ✎ Edit Writing Style
                        </button>
                        <button onClick={() => setShowSegmentViewer(true)} style={{ flex: 1, padding: "9px", background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, fontFamily: "inherit", fontSize: 12, fontWeight: 500, color: TEXT_SECONDARY, cursor: "pointer" }}>
                          ◎ Edit Segment Focus
                        </button>
                      </div>
                    </div>
                    <button onClick={() => setShowSetup(true)} style={{ padding: "10px", background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, fontFamily: "inherit", fontSize: 12, color: TEXT_SECONDARY, cursor: "pointer", textAlign: "left" }}>
                      ↺ Re-run Style Setup
                    </button>
                  </>
                ) : (
                  <button onClick={() => setShowSetup(true)} style={{ padding: "14px", background: ACCENT, border: "none", borderRadius: 8, fontFamily: "inherit", fontSize: 13, fontWeight: 600, color: ACCENT_TEXT, cursor: "pointer" }}>
                    Set Up Your Style Profile
                  </button>
                )}
              </div>

              {/* ── Deploy section ── */}
              <div style={{ marginTop: 28 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: TEXT, marginBottom: 12 }}>App Deployment</div>
                <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 20 }}>
                  <div style={{ fontSize: 13, color: TEXT_SECONDARY, marginBottom: 14, lineHeight: 1.5 }}>
                    Trigger a fresh Vercel build — useful after code changes are merged or env vars are updated.
                  </div>
                  <button
                    disabled={deployStatus === "deploying"}
                    onClick={async () => {
                      setDeployStatus("deploying");
                      try {
                        const res = await fetch("/api/deploy", { method: "POST" });
                        const data = await res.json();
                        if (!res.ok) {
                          console.error("[deploy]", data.error);
                          setDeployStatus("error");
                        } else {
                          setDeployStatus("done");
                        }
                      } catch (e) {
                        console.error("[deploy]", e);
                        setDeployStatus("error");
                      }
                      setTimeout(() => setDeployStatus("idle"), 6000);
                    }}
                    style={{
                      width: "100%",
                      padding: "10px 16px",
                      background: deployStatus === "done" ? SUCCESS : deployStatus === "error" ? "#c0392b" : deployStatus === "deploying" ? SURFACE : ACCENT,
                      border: deployStatus === "deploying" ? `1px solid ${BORDER}` : "none",
                      borderRadius: 8,
                      fontFamily: "inherit",
                      fontSize: 13,
                      fontWeight: 600,
                      color: deployStatus === "deploying" ? MUTED : ACCENT_TEXT,
                      cursor: deployStatus === "deploying" ? "not-allowed" : "pointer",
                      transition: "background 0.2s",
                    }}
                  >
                    {deployStatus === "deploying" ? "⏳ Deploying…" : deployStatus === "done" ? "✓ Deploy triggered" : deployStatus === "error" ? "✗ Deploy failed — check VERCEL_DEPLOY_HOOK" : "🚀 Deploy Now"}
                  </button>
                  {deployStatus === "done" && (
                    <div style={{ fontSize: 11, color: TEXT_SECONDARY, marginTop: 8 }}>
                      Build queued — usually live in ~60 seconds. Check Vercel dashboard for progress.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Outreach + Reports (existing layout) ── */}
        {(sideNav === "outreach" || sideNav === "reports") && (<>
        <div style={{ width: sidebarCollapsed ? 0 : 340, minWidth: sidebarCollapsed ? 0 : 300, borderRight: sidebarCollapsed ? "none" : `1px solid ${BORDER}`, padding: sidebarCollapsed ? 0 : 20, display: sideNav === "reports" ? "none" : "flex", flexDirection: "column", gap: 14, background: SURFACE, overflow: "hidden", transition: "width 0.2s ease, min-width 0.2s ease, padding 0.2s ease", flexShrink: 0 }}>
          <div style={{ background: BG, borderRadius: 10, padding: 18 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>Target Organization</div>
              <div style={{ display: "flex", background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 3, gap: 2 }}>
                {[["Single", "single"], ["Batch", "batch"], ["List", "list"]].map(([label, val]) => {
                  const isActive = val === "list" ? listMode : val === "batch" ? (batchMode && !listMode) : (!batchMode && !listMode);
                  return (
                    <button key={val} onClick={() => { setListMode(val === "list"); setBatchMode(val === "batch"); }}
                      style={{ padding: "4px 12px", fontSize: 11, fontFamily: "inherit", border: "none", borderRadius: 6, cursor: "pointer", background: isActive ? SURFACE : "transparent", color: isActive ? TEXT : MUTED, fontWeight: isActive ? 500 : 400, boxShadow: isActive ? "0 1px 2px rgba(0,0,0,0.06)" : "none", transition: "all 0.12s" }}>
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            {listMode ? (
              <div>
                <label style={{ display: "block", border: `2px dashed ${uploadedOrgs.length ? SUCCESS : BORDER}`, borderRadius: 8, padding: "16px 12px", textAlign: "center", cursor: "pointer", background: uploadedOrgs.length ? "rgba(0,146,98,0.04)" : BG, marginBottom: 12 }}>
                  <input type="file" accept=".xlsx,.csv,.xls" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) handleFileImport(f, "generate"); e.target.value = ""; }} />
                  {importLoading ? (
                    <div style={{ fontSize: 12, color: MUTED }}>Parsing…</div>
                  ) : uploadedOrgs.length ? (
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: SUCCESS }}>✓ {uploadedOrgs.reduce((n, o) => n + o.contacts.length, 0)} contacts · {uploadedOrgs.length} orgs</div>
                      <div style={{ fontSize: 11, color: TEXT_SECONDARY, marginTop: 2 }}>{uploadFileName}</div>
                      <div style={{ fontSize: 10, color: MUTED, marginTop: 3 }}>Click to replace</div>
                    </div>
                  ) : (
                    <div>
                      <div style={{ fontSize: 20, marginBottom: 6, opacity: 0.3 }}>📂</div>
                      <div style={{ fontSize: 12, color: TEXT_SECONDARY }}>Click to upload XLSX or CSV</div>
                      <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>First Name · Last Name · Title · Email · Organization · Category</div>
                    </div>
                  )}
                </label>

                {uploadedOrgs.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: TEXT_SECONDARY, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 2 }}>What do you want to do with this list?</div>
                    <button
                      onClick={() => { setImportPreviewEntries(uploadedEntries); setShowImportModal("reports"); }}
                      style={{ width: "100%", padding: "11px 12px", background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 7, fontFamily: "inherit", fontSize: 12, fontWeight: 500, color: TEXT, cursor: "pointer", textAlign: "left", lineHeight: 1.4 }}>
                      <div style={{ fontWeight: 600, color: TEXT }}>↓ Import to Activity Log</div>
                      <div style={{ color: MUTED, fontSize: 11, marginTop: 2 }}>Already contacted — add to your pipeline without generating emails</div>
                    </button>
                    {/* Parallel / Sequential toggle */}
                    {!running && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: BG, borderRadius: 7, border: `1px solid ${BORDER}` }}>
                        <button
                          onClick={() => setUseParallelMode(v => !v)}
                          style={{ width: 36, height: 20, borderRadius: 10, background: useParallelMode ? ACCENT : BORDER, border: "none", cursor: "pointer", position: "relative", transition: "background 0.2s", flexShrink: 0, padding: 0 }}>
                          <span style={{ position: "absolute", top: 2, left: useParallelMode ? 18 : 2, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s", display: "block" }} />
                        </button>
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 600, color: useParallelMode ? ACCENT : TEXT_SECONDARY }}>
                            {useParallelMode ? "⚡ Parallel mode — all orgs at once" : "Sequential mode — one at a time"}
                          </div>
                          <div style={{ fontSize: 10, color: MUTED, marginTop: 1 }}>
                            {useParallelMode ? "Orchestrator fans out 5 agents simultaneously" : "Classic mode, slower but lower API usage"}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Orchestrator progress bar */}
                    {orchProgress && running && (
                      <div style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: "12px 14px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: ACCENT }}>⚡ Agent team running</span>
                          <span style={{ fontSize: 12, color: TEXT_SECONDARY }}>{orchProgress.completed} / {orchProgress.total} orgs</span>
                        </div>
                        <div style={{ background: BORDER, borderRadius: 4, height: 6, overflow: "hidden" }}>
                          <div style={{ height: "100%", borderRadius: 4, background: ACCENT, width: `${orchProgress.total > 0 ? (orchProgress.completed / orchProgress.total) * 100 : 0}%`, transition: "width 0.4s ease" }} />
                        </div>
                        <div style={{ fontSize: 10, color: MUTED, marginTop: 6 }}>Drafts appear below as each org completes</div>
                      </div>
                    )}

                    {running && !orchProgress ? (
                      <button
                        onClick={() => { cancelledRef.current = true; }}
                        style={{ width: "100%", padding: "11px 12px", background: "#E53935", border: "none", borderRadius: 7, fontFamily: "inherit", fontSize: 12, fontWeight: 600, color: "#fff", cursor: "pointer", textAlign: "center", lineHeight: 1.4 }}>
                        ⏹ Stop Workflow
                      </button>
                    ) : !running ? (
                      <button
                        onClick={handleRunClick}
                        style={{ width: "100%", padding: "11px 12px", background: ACCENT, border: "none", borderRadius: 7, fontFamily: "inherit", fontSize: 12, fontWeight: 500, color: ACCENT_TEXT, cursor: "pointer", textAlign: "left", lineHeight: 1.4 }}>
                        <div style={{ fontWeight: 600 }}>✉ Generate New Emails</div>
                        <div style={{ fontSize: 11, marginTop: 2, opacity: 0.85 }}>{useParallelMode ? "All orgs run simultaneously via agent team" : "Research each org and draft outreach — skips anyone already in your pipeline"}</div>
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            ) : (
              <>
                <div style={{ fontSize: 11, fontWeight: 500, color: TEXT_SECONDARY, marginBottom: 5 }}>{batchMode ? "Starting Point" : "Organization Name"}</div>
                <input style={{ width: "100%", background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 7, padding: "9px 12px", color: TEXT, fontFamily: "inherit", fontSize: 13, outline: "none", boxSizing: "border-box" }}
                  value={orgName} onChange={e => setOrgName(e.target.value)} placeholder={batchMode ? "Starting org — we'll find 10 similar" : "Organization name"} />
                {!batchMode && (<>
                  <div style={{ fontSize: 11, fontWeight: 500, color: TEXT_SECONDARY, marginBottom: 5, marginTop: 12 }}>Org Type <span style={{ color: MUTED, fontWeight: 400 }}>(optional)</span></div>
                  <input style={{ width: "100%", background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 7, padding: "9px 12px", color: TEXT, fontFamily: "inherit", fontSize: 13, outline: "none", boxSizing: "border-box" }}
                    value={orgType} onChange={e => setOrgType(e.target.value)} placeholder="Professional Association, Student Org…" />
                </>)}
                <div style={{ fontSize: 11, fontWeight: 500, color: TEXT_SECONDARY, marginBottom: 5, marginTop: 12 }}>Context <span style={{ color: MUTED, fontWeight: 400 }}>(optional)</span></div>
                <textarea style={{ width: "100%", background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 7, padding: "9px 12px", color: TEXT, fontFamily: "inherit", fontSize: 13, outline: "none", resize: "vertical", minHeight: 60, boxSizing: "border-box" }}
                  value={orgContext} onChange={e => setOrgContext(e.target.value)} placeholder={batchMode ? "Focus on orgs with large annual conferences…" : "Runs national conferences with 10k+ attendees..."} />
                {running && (batchMode) ? (
                  <button onClick={() => { cancelledRef.current = true; }}
                    style={{ width: "100%", padding: "12px", background: "#E53935", border: "none", borderRadius: 7, fontFamily: "inherit", fontSize: 13, fontWeight: 600, color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 14 }}>
                    ⏹ Stop Workflow
                  </button>
                ) : (
                  <button onClick={handleRunClick} disabled={running || !orgName}
                    style={{ width: "100%", padding: "11px", background: running || !orgName ? BG : INDIGO, border: `1px solid ${running || !orgName ? BORDER : INDIGO}`, borderRadius: 8, fontFamily: "inherit", fontSize: 13, fontWeight: 500, color: running || !orgName ? MUTED : "#fff", cursor: running || !orgName ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 14, letterSpacing: "-0.01em" }}>
                    {running ? "Running…" : batchMode ? "Find 10 Orgs & Draft Emails" : styleProfile ? "Run Full Workflow →" : "Set Up Style & Run"}
                  </button>
                )}
              </>
            )}
          </div>

          <div style={{ background: BG, borderRadius: 10, padding: 18 }}>
            <Steps steps={stepStates} />
            <div style={{ fontSize: 12, color: status.cls === "error" ? ERROR : status.cls === "success" ? SUCCESS : TEXT_SECONDARY, textAlign: "center", minHeight: 18, marginTop: 8 }}>{status.msg}</div>
            {logs.length > 0 && (
              <div style={{ marginTop: 10, borderTop: `1px solid ${BORDER}`, paddingTop: 10 }}>
                {logs.map((l, i) => <div key={i} style={{ fontSize: 11, color: l.cls === "ok" ? SUCCESS : l.cls === "err" ? ERROR : l.cls === "info" ? INFO : MUTED, padding: "2px 0" }}>› {l.msg}</div>)}
              </div>
            )}
          </div>
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", padding: "10px 16px", background: SURFACE, borderBottom: `1px solid ${BORDER}`, gap: 2 }}>
            <div style={{ display: "flex", background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 3, gap: 2 }}>
              {["contacts", "drafts", "sent", "reports"].map(t => (
                <button key={t} onClick={() => setTab(t)} style={{ padding: "5px 14px", fontSize: 12, fontWeight: tab === t ? 500 : 400, color: tab === t ? TEXT : MUTED, border: "none", borderRadius: 6, background: tab === t ? SURFACE : "transparent", cursor: "pointer", fontFamily: "inherit", boxShadow: tab === t ? "0 1px 2px rgba(0,0,0,0.06)" : "none", transition: "all 0.12s", display: "flex", alignItems: "center", gap: 5 }}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                  {t === "contacts" && contacts.length > 0 && <span style={{ background: INDIGO_BG, color: INDIGO, borderRadius: 10, padding: "0px 6px", fontSize: 10, fontWeight: 500 }}>{contacts.length}</span>}
                  {t === "drafts" && drafts.length > 0 && <span style={{ background: INDIGO_BG, color: INDIGO, borderRadius: 10, padding: "0px 6px", fontSize: 10, fontWeight: 500 }}>{drafts.length}</span>}
                  {t === "sent" && sent.length > 0 && <span style={{ background: INDIGO_BG, color: INDIGO, borderRadius: 10, padding: "0px 6px", fontSize: 10, fontWeight: 500 }}>{sent.length}</span>}
                  {t === "reports" && reportEntries.length > 0 && <span style={{ background: INDIGO_BG, color: INDIGO, borderRadius: 10, padding: "0px 6px", fontSize: 10, fontWeight: 500 }}>{reportEntries.filter(e => e.status === "Sent").length}</span>}
                </button>
              ))}
            </div>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
            {tab === "contacts" && (contacts.length === 0
              ? <div style={{ padding: "80px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}><div style={{ fontSize: 40, opacity: 0.15 }}>👤</div><div style={{ fontSize: 14, color: MUTED }}>Run the workflow to find contacts</div></div>
              : contacts.map((c, i) => (
                <div key={i} style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 16, display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 10, boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
                  <div style={{ width: 38, height: 38, borderRadius: "50%", background: "rgba(253,75,35,0.08)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 14, color: ACCENT, flexShrink: 0 }}>{c.name.charAt(0)}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: TEXT }}>{c.name}</div>
                    <div style={{ fontSize: 12, color: TEXT_SECONDARY, marginTop: 2 }}>{c.title} · {c.company}</div>
                    {c.orgWebsite && (
                      <a href={c.orgWebsite.startsWith("http") ? c.orgWebsite : `https://${c.orgWebsite}`} target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: 11, color: INFO, marginTop: 3, display: "inline-block", textDecoration: "none" }}>
                        🌐 {c.orgWebsite.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                      </a>
                    )}
                    <div style={{ fontSize: 12, color: INFO, marginTop: 4 }}>{c.email}</div>
                  </div>
                  <div style={{ fontSize: 10, padding: "3px 8px", borderRadius: 20, fontWeight: 500,
                    background: c.source === "ZoomInfo" ? "rgba(20,118,216,0.08)"
                      : c.source === "Website" ? "rgba(22,163,74,0.1)"
                      : c.source === "Press Release" ? "rgba(22,163,74,0.1)"
                      : (c.source || "").startsWith("Pattern") ? "rgba(234,179,8,0.12)"
                      : c.source === "Predicted" ? "rgba(107,114,128,0.1)"
                      : "rgba(253,75,35,0.08)",
                    color: c.source === "ZoomInfo" ? INFO
                      : c.source === "Website" || c.source === "Press Release" ? SUCCESS
                      : (c.source || "").startsWith("Pattern") ? "#B45309"
                      : c.source === "Predicted" ? MUTED
                      : ACCENT }}>
                    {c.emailVerified ? "✓ " : ""}{c.source}
                  </div>
                </div>
              ))
            )}

            {tab === "drafts" && (drafts.length === 0
              ? <div style={{ padding: "80px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}><div style={{ fontSize: 40, opacity: 0.15 }}>✉</div><div style={{ fontSize: 14, color: MUTED }}>Run the workflow to generate drafts</div></div>
              : drafts.map((d, i) => (
                <div key={i} style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 20, marginBottom: 14, boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <div style={{ fontSize: 12, color: TEXT_SECONDARY }}>
                          To: <span style={{ color: TEXT, fontWeight: 500 }}>{d.to}</span>
                          {d.email && editingEmail !== i && (
                            <span style={{ color: MUTED }}> {"<"}{d.email}{">"}</span>
                          )}
                        </div>
                        {/* Inline email editor */}
                        {editingEmail === i ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <input
                              autoFocus
                              type="email"
                              value={emailEditText}
                              onChange={e => setEmailEditText(e.target.value)}
                              onKeyDown={e => { if (e.key === "Enter") saveEmailEdit(i); if (e.key === "Escape") { setEditingEmail(null); setEmailEditText(""); } }}
                              placeholder="Enter email address"
                              style={{ fontSize: 12, padding: "4px 8px", border: `1px solid ${ACCENT}`, borderRadius: 6, fontFamily: "inherit", outline: "none", width: 220, color: TEXT, background: SURFACE }}
                            />
                            <button onClick={() => saveEmailEdit(i)}
                              style={{ fontSize: 11, fontWeight: 600, padding: "4px 10px", background: ACCENT, color: ACCENT_TEXT, border: "none", borderRadius: 6, cursor: "pointer", fontFamily: "inherit" }}>
                              Save
                            </button>
                            <button onClick={() => { setEditingEmail(null); setEmailEditText(""); }}
                              style={{ fontSize: 11, padding: "4px 8px", background: "none", color: MUTED, border: `1px solid ${BORDER}`, borderRadius: 6, cursor: "pointer", fontFamily: "inherit" }}>
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <>
                            {!d.email && (
                              <button onClick={() => { setEditingEmail(i); setEmailEditText(""); }}
                                title="Click to add email address"
                                style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20, background: "rgba(229,57,53,0.1)", color: ERROR, border: "none", cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4 }}>
                                ✕ No email — click to add
                              </button>
                            )}
                            {d.email && !d.emailVerified && (
                              <button onClick={() => { setEditingEmail(i); setEmailEditText(d.email); }}
                                title={`Source: ${d.contactSource || "unknown"} — click to correct if wrong`}
                                style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20, background: "rgba(255,152,0,0.12)", color: "#E65100", border: "none", cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4 }}>
                                ⚠ Unverified — click to confirm
                              </button>
                            )}
                            {d.email && d.emailVerified && (
                              <button onClick={() => { setEditingEmail(i); setEmailEditText(d.email); }}
                                title={`Verified via ${d.contactSource} — click to edit`}
                                style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20, background: "rgba(0,146,98,0.08)", color: SUCCESS, border: "none", cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4 }}>
                                ✓ Verified — click to edit
                              </button>
                            )}
                          </>
                        )}
                      </div>
                      {d.subjectB ? (
                        <div style={{ marginTop: 6 }}>
                          <div style={{ fontSize: 11, color: MUTED, marginBottom: 4, fontWeight: 500, letterSpacing: "0.03em" }}>SUBJECT LINE — PICK ONE</div>
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <button
                              onClick={() => setDrafts(prev => prev.map((dr, idx) => idx === i ? { ...dr, selectedVariant: "A" } : dr))}
                              style={{ fontSize: 13, padding: "5px 12px", borderRadius: 6, border: `1.5px solid ${(!d.selectedVariant || d.selectedVariant === "A") ? ACCENT : BORDER}`, background: (!d.selectedVariant || d.selectedVariant === "A") ? `rgba(253,75,35,0.08)` : "transparent", color: (!d.selectedVariant || d.selectedVariant === "A") ? ACCENT : TEXT_SECONDARY, cursor: "pointer", fontFamily: "inherit", fontWeight: (!d.selectedVariant || d.selectedVariant === "A") ? 600 : 400, textAlign: "left" }}>
                              <span style={{ fontSize: 10, fontWeight: 700, marginRight: 5, opacity: 0.7 }}>A</span>{d.subject}
                            </button>
                            <button
                              onClick={() => setDrafts(prev => prev.map((dr, idx) => idx === i ? { ...dr, selectedVariant: "B" } : dr))}
                              style={{ fontSize: 13, padding: "5px 12px", borderRadius: 6, border: `1.5px solid ${d.selectedVariant === "B" ? ACCENT : BORDER}`, background: d.selectedVariant === "B" ? `rgba(253,75,35,0.08)` : "transparent", color: d.selectedVariant === "B" ? ACCENT : TEXT_SECONDARY, cursor: "pointer", fontFamily: "inherit", fontWeight: d.selectedVariant === "B" ? 600 : 400, textAlign: "left" }}>
                              <span style={{ fontSize: 10, fontWeight: 700, marginRight: 5, opacity: 0.7 }}>B</span>{d.subjectB}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ fontSize: 15, fontWeight: 600, color: TEXT, marginTop: 4 }}>{d.subject}</div>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      {d.sentAt && <span style={{ fontSize: 11, padding: "3px 9px", borderRadius: 20, background: "rgba(0,146,98,0.08)", color: SUCCESS, fontWeight: 500 }}>Sent {d.sentAt}</span>}
                      {d.edited && !d.sentAt && <span style={{ fontSize: 11, padding: "3px 9px", borderRadius: 20, background: "rgba(253,75,35,0.08)", color: ACCENT, fontWeight: 500 }}>Edited</span>}
                    </div>
                  </div>

                  {d.research && (
                    <div style={{ marginBottom: 12 }}>
                      <button
                        onClick={() => setExpandedResearch(expandedResearch === i ? null : i)}
                        style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, color: expandedResearch === i ? ACCENT : TEXT_SECONDARY, padding: 0, display: "flex", alignItems: "center", gap: 4 }}>
                        {expandedResearch === i ? "▾" : "▸"} Research Notes
                      </button>
                      {expandedResearch === i && (
                        <div style={{ marginTop: 8, padding: "12px 14px", background: BG, border: `1px solid ${BORDER}`, borderRadius: 7, fontSize: 12, color: TEXT_SECONDARY, lineHeight: 1.65 }}>
                          {d.research}
                        </div>
                      )}
                    </div>
                  )}

                  {editingDraft === i ? (
                    <div>
                      <textarea
                        value={editText}
                        onChange={e => setEditText(e.target.value)}
                        style={{ width: "100%", background: BG, border: `1px solid ${ACCENT}`, borderRadius: 7, padding: "12px 14px", color: TEXT, fontFamily: "inherit", fontSize: 13, outline: "none", resize: "vertical", minHeight: 180, boxSizing: "border-box", lineHeight: 1.65 }}
                      />
                      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                        <button onClick={() => saveEdit(i)}
                          style={{ padding: "8px 16px", background: ACCENT, color: ACCENT_TEXT, border: "none", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                          Save & Update Style
                        </button>
                        <button onClick={() => setEditingDraft(null)}
                          style={{ padding: "8px 16px", background: "transparent", color: TEXT_SECONDARY, border: `1px solid ${BORDER}`, borderRadius: 7, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
                          Cancel
                        </button>
                      </div>
                      <div style={{ fontSize: 11, color: MUTED, marginTop: 8 }}>
                        Edits are saved to improve future drafts automatically.
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize: 13, color: TEXT_SECONDARY, lineHeight: 1.7, whiteSpace: "pre-wrap", borderTop: `1px solid ${BORDER}`, paddingTop: 12 }}>{d.edited || d.body}</div>
                      {!d.sentAt && (
                        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}>
                          <button
                            onClick={() => d.email ? openInGmail(d, i, true) : undefined}
                            disabled={!d.email}
                            title={!d.email ? "Add an email address before sending" : d.emailVerified ? `Verified email — found on ${d.contactSource}` : "Email unverified — confirm it's correct before sending"}
                            style={{ padding: "8px 16px", background: d.email ? ACCENT : BORDER, color: d.email ? ACCENT_TEXT : MUTED, border: "none", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: d.email ? "pointer" : "not-allowed", fontFamily: "inherit" }}>
                            {!d.email ? "✕ No Email" : "Open in Gmail"}
                          </button>
                          <button onClick={() => startEditing(i)}
                            style={{ padding: "8px 16px", background: "transparent", color: TEXT_SECONDARY, border: `1px solid ${BORDER}`, borderRadius: 7, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
                            Edit Draft
                          </button>
                          {d.email && (
                            <button onClick={() => openInGmail(d, i, false)}
                              style={{ padding: "8px 16px", background: "transparent", color: TEXT_SECONDARY, border: `1px solid ${BORDER}`, borderRadius: 7, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
                              Preview
                            </button>
                          )}
                          {!d.email && (
                            <span style={{ fontSize: 11, color: MUTED, fontStyle: "italic" }}>
                              Find the email on LinkedIn or the org&apos;s website, then edit the draft to add it.
                            </span>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))
            )}

            {tab === "sent" && (sent.length === 0
              ? <div style={{ padding: "80px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}><div style={{ fontSize: 40, opacity: 0.15 }}>📤</div><div style={{ fontSize: 14, color: MUTED }}>No sent emails yet</div></div>
              : sent.map((item, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 0", borderBottom: `1px solid ${BORDER}` }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 500, color: TEXT }}>{item.to}</div>
                    <div style={{ fontSize: 12, color: TEXT_SECONDARY, marginTop: 2 }}>{item.subject}</div>
                  </div>
                  <div style={{ fontSize: 12, color: MUTED }}>{item.sentAt}</div>
                </div>
              ))
            )}

            {tab === "reports" && (() => {
              const myName = styleProfile?.repName || "";
              const unassignedEntries = myName ? reportEntries.filter(e => !e.repName) : [];
              const claimUnassigned = async () => {
                if (!myName || unassignedEntries.length === 0) return;
                const updated = reportEntries.map(e => e.repName ? e : { ...e, repName: myName });
                setReportEntries(updated);
                // Persist to DB
                const toSave = unassignedEntries.map(e => ({ ...e, repName: myName }));
                fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(toSave) }).catch(() => {});
              };
              const visibleEntries = repView === "mine" && myName
                ? reportEntries.filter(e => e.repName === myName)
                : reportEntries;
              const sentEntries = visibleEntries.filter(e => e.status === "Sent");
              const sentOrgs = [...new Set(sentEntries.map(e => e.organization))];
              const overdueEntries = visibleEntries.filter(e => isOverdue(e));
              const catCounts: Record<string, number> = {};
              visibleEntries.forEach(e => { catCounts[e.smerfCategory] = (catCounts[e.smerfCategory] || 0) + 1; });
              // Per-rep breakdown for All Reps view
              const repNames = [...new Set(reportEntries.map(e => e.repName).filter(Boolean))];
              const repCounts = repNames.map(name => ({
                name,
                total: reportEntries.filter(e => e.repName === name).length,
                sent: reportEntries.filter(e => e.repName === name && e.status === "Sent").length,
                overdue: reportEntries.filter(e => e.repName === name && isOverdue(e)).length,
              }));
              // Due-this-week entries (not overdue, due within 7 days)
              const dueThisWeek = visibleEntries.filter(e => {
                const next = nextFollowUp(e);
                if (!next || isOverdue(e)) return false;
                const due = parseLocalDate(next.due);
                const tod = new Date(); tod.setHours(0, 0, 0, 0);
                const wk = new Date(tod); wk.setDate(tod.getDate() + 7);
                return due >= tod && due <= wk;
              });
              const proposalEntries = visibleEntries.filter(e => e.stage === "Proposal");
              // Duplicate org detection — orgs that appear more than once in visible entries
              const orgCounts: Record<string, number> = {};
              visibleEntries.forEach(e => {
                if (e.organization) orgCounts[e.organization] = (orgCounts[e.organization] || 0) + 1;
              });
              const duplicateOrgs = new Set(Object.keys(orgCounts).filter(org => orgCounts[org] > 1));
              const duplicateEntries = visibleEntries.filter(e => duplicateOrgs.has(e.organization));
              // Apply action filter to visible entries, then text search
              const actionFilteredEntries = logFilter === "overdue" ? overdueEntries
                : logFilter === "week" ? dueThisWeek
                : logFilter === "duplicates" ? duplicateEntries
                : (STAGES as readonly string[]).includes(logFilter) ? visibleEntries.filter(e => e.stage === logFilter)
                : visibleEntries;

              return (
                <div>
                  {/* Today's Actions bar */}
                  {(overdueEntries.length > 0 || dueThisWeek.length > 0 || proposalEntries.length > 0 || duplicateOrgs.size > 0) && (
                    <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "12px 18px", marginBottom: 20, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: TEXT, marginRight: 4 }}>Today's Actions</span>
                      {overdueEntries.length > 0 && (
                        <button
                          onClick={() => { setLogFilter(logFilter === "overdue" ? "all" : "overdue"); setReportSubTab("log"); }}
                          style={{ fontSize: 12, fontWeight: 600, padding: "5px 12px", borderRadius: 20, border: "none", cursor: "pointer", fontFamily: "inherit", background: logFilter === "overdue" ? ACCENT : "rgba(253,75,35,0.1)", color: logFilter === "overdue" ? ACCENT_TEXT : ACCENT, transition: "all 0.15s" }}>
                          ⚠ {overdueEntries.length} overdue
                        </button>
                      )}
                      {dueThisWeek.length > 0 && (
                        <button
                          onClick={() => { setLogFilter(logFilter === "week" ? "all" : "week"); setReportSubTab("log"); }}
                          style={{ fontSize: 12, fontWeight: 600, padding: "5px 12px", borderRadius: 20, border: "none", cursor: "pointer", fontFamily: "inherit", background: logFilter === "week" ? INFO : "rgba(20,118,216,0.1)", color: logFilter === "week" ? "#fff" : INFO, transition: "all 0.15s" }}>
                          📅 {dueThisWeek.length} due this week
                        </button>
                      )}
                      {proposalEntries.length > 0 && (
                        <button
                          onClick={() => { setLogFilter(logFilter === "Proposal" ? "all" : "Proposal"); setReportSubTab("log"); }}
                          style={{ fontSize: 12, fontWeight: 600, padding: "5px 12px", borderRadius: 20, border: "none", cursor: "pointer", fontFamily: "inherit", background: logFilter === "Proposal" ? "rgba(253,75,35,0.85)" : "rgba(253,75,35,0.08)", color: logFilter === "Proposal" ? "#fff" : ACCENT, transition: "all 0.15s" }}>
                          📋 {proposalEntries.length} in Proposal
                        </button>
                      )}
                      {duplicateOrgs.size > 0 && (
                        <button
                          onClick={() => { setLogFilter(logFilter === "duplicates" ? "all" : "duplicates"); setReportSubTab("log"); }}
                          style={{ fontSize: 12, fontWeight: 600, padding: "5px 12px", borderRadius: 20, border: "none", cursor: "pointer", fontFamily: "inherit", background: logFilter === "duplicates" ? "#7C3AED" : "rgba(124,58,237,0.1)", color: logFilter === "duplicates" ? "#fff" : "#7C3AED", transition: "all 0.15s" }}>
                          🔁 {duplicateOrgs.size} duplicate org{duplicateOrgs.size !== 1 ? "s" : ""}
                        </button>
                      )}
                      {logFilter !== "all" && (
                        <button onClick={() => setLogFilter("all")}
                          style={{ fontSize: 11, color: MUTED, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", marginLeft: "auto", padding: "4px 8px" }}>
                          Clear filter ×
                        </button>
                      )}
                    </div>
                  )}
                  {/* Sub-tabs */}
                  <div style={{ display: "flex", gap: 0, marginBottom: 24, borderBottom: `1px solid ${BORDER}`, marginLeft: -24, marginRight: -24, paddingLeft: 24, alignItems: "center" }}>
                    {([["log", "Activity Log"], ["summary", "Dashboard"], ["followups", "Follow-Ups"]] as const).map(([id, label]) => (
                      <button key={id} onClick={() => setReportSubTab(id)}
                        style={{ padding: "10px 18px", fontSize: 13, fontWeight: reportSubTab === id ? 600 : 400, color: reportSubTab === id ? TEXT : MUTED, border: "none", background: "none", cursor: "pointer", borderBottom: `2px solid ${reportSubTab === id ? ACCENT : "transparent"}`, marginBottom: -1, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}>
                        {label}
                        {id === "followups" && (() => {
                          const repliedCount = visibleEntries.filter(e => e.repliedAt).length;
                          const total = overdueEntries.length + dueThisWeek.length + autoDrafts.length + preDrafts.length + repliedCount;
                          return total > 0 ? (
                            <span style={{ background: repliedCount > 0 ? SUCCESS : autoDrafts.length > 0 ? ACCENT : overdueEntries.length > 0 ? ACCENT : INFO, color: "#fff", fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 20, lineHeight: 1.5 }}>
                              {total}
                            </span>
                          ) : null;
                        })()}
                      </button>
                    ))}
                    {styleProfile && (
                      <div style={{ display: "flex", background: BG, border: `1px solid ${BORDER}`, borderRadius: 6, overflow: "hidden", marginLeft: 16 }}>
                        {([["mine", `My Pipeline`], ["all", "All Reps"]] as const).map(([val, label]) => (
                          <button key={val} onClick={() => setRepView(val)}
                            style={{ padding: "4px 12px", fontSize: 11, fontFamily: "inherit", border: "none", cursor: "pointer", background: repView === val ? ACCENT : "transparent", color: repView === val ? ACCENT_TEXT : MUTED, fontWeight: repView === val ? 600 : 400 }}>
                            {label}
                          </button>
                        ))}
                      </div>
                    )}
                    {repView === "mine" && unassignedEntries.length > 0 && (
                      <button onClick={claimUnassigned}
                        style={{ marginLeft: 8, background: "rgba(20,118,216,0.08)", color: INFO, fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 20, border: `1px solid rgba(20,118,216,0.25)`, cursor: "pointer", fontFamily: "inherit" }}>
                        + Claim {unassignedEntries.length} unassigned
                      </button>
                    )}
                    {overdueEntries.length > 0 && (
                      <span style={{ marginLeft: 8, background: "rgba(253,75,35,0.1)", color: ACCENT, fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 20 }}>
                        {overdueEntries.length} follow-up{overdueEntries.length > 1 ? "s" : ""} overdue
                      </span>
                    )}
                    <div style={{ marginLeft: "auto", marginRight: 24, display: "flex", alignItems: "center", gap: 8 }}>
                      <button
                        onClick={() => setSidebarCollapsed(v => !v)}
                        style={{ padding: "6px 12px", fontSize: 12, fontWeight: 500, color: sidebarCollapsed ? ACCENT : TEXT_SECONDARY, border: `1px solid ${sidebarCollapsed ? ACCENT : BORDER}`, borderRadius: 6, background: sidebarCollapsed ? "rgba(253,75,35,0.06)" : SURFACE, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5 }}>
                        {sidebarCollapsed ? "⊞ Show Workflow" : "⊟ Hide Workflow"}
                      </button>
                      <button
                        onClick={() => setShowImportModal("reports")}
                        style={{ padding: "6px 14px", fontSize: 12, fontWeight: 500, color: TEXT_SECONDARY, border: `1px solid ${BORDER}`, borderRadius: 6, background: SURFACE, cursor: "pointer", fontFamily: "inherit" }}>
                        ↑ Import
                      </button>
                      {visibleEntries.length > 0 && (<>
                        <button
                          onClick={() => {
                            const headers = ["Organization","Contact","Title","Email","Rep","Category","Stage","Status","Date Sent","Follow-Up Due","Subject","Notes","Wave"];
                            const rows = visibleEntries.map(e => [
                              e.organization, e.contactName, e.title, e.email, e.repName,
                              e.smerfCategory, e.stage, e.status,
                              e.dateSent || "", e.followUpDue || "",
                              e.subjectLine, e.notes, String(e.wave),
                            ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(","));
                            const csv = [headers.join(","), ...rows].join("\n");
                            const blob = new Blob([csv], { type: "text/csv" });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url; a.download = `engine-pipeline-${new Date().toISOString().split("T")[0]}.csv`;
                            a.click(); URL.revokeObjectURL(url);
                          }}
                          style={{ padding: "6px 14px", fontSize: 12, fontWeight: 500, color: TEXT_SECONDARY, border: `1px solid ${BORDER}`, borderRadius: 6, background: SURFACE, cursor: "pointer", fontFamily: "inherit" }}>
                          ↓ Export CSV
                        </button>
                        {/* Clear Data button removed — too destructive. Delete rows individually via the Activity Log. */}
                      </>)}
                    </div>
                  </div>

                  {visibleEntries.length === 0 ? (
                    <div style={{ padding: "80px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                      <div style={{ fontSize: 40, opacity: 0.15 }}>📊</div>
                      <div style={{ fontSize: 14, color: MUTED }}>{repView === "mine" ? "No entries for you yet — run the workflow to start tracking" : "Run a workflow and send emails to start tracking"}</div>
                    </div>
                  ) : reportSubTab === "summary" ? (
                    <div>
                      {(() => {
                        // ── Date range filter state (local to this render) ───────────────────
                        const dashRange = (window as unknown as Record<string,unknown>).__dashRange as string || "30d";
                        const setDashRange = (r: string) => { (window as unknown as Record<string,unknown>).__dashRange = r; setReportSubTab("summary"); };
                        const now = new Date();
                        const cutoff = dashRange === "7d" ? new Date(now.getTime() - 7*86400000)
                          : dashRange === "30d" ? new Date(now.getTime() - 30*86400000)
                          : dashRange === "90d" ? new Date(now.getTime() - 90*86400000)
                          : new Date(0);
                        const prevCutoff = dashRange === "7d" ? new Date(now.getTime() - 14*86400000)
                          : dashRange === "30d" ? new Date(now.getTime() - 60*86400000)
                          : dashRange === "90d" ? new Date(now.getTime() - 180*86400000)
                          : new Date(0);
                        const cutoffStr = cutoff.toISOString().slice(0,10);
                        const prevCutoffStr = prevCutoff.toISOString().slice(0,10);
                        const todayStr = now.toISOString().slice(0,10);
                        const thirtyDaysAgo = new Date(Date.now() - 30*86400000).toISOString().slice(0,10);

                        // ── Windowed entries ─────────────────────────────────────────────────
                        const windowedSent = sentEntries.filter(e => (e.dateSent||"") >= cutoffStr);
                        const prevWindowSent = sentEntries.filter(e => (e.dateSent||"") >= prevCutoffStr && (e.dateSent||"") < cutoffStr);
                        const fuSent = windowedSent.filter(e => e.followUpSent).length;
                        const fu2Sent = windowedSent.filter(e => e.followUp2Sent).length;
                        const fu3Sent = windowedSent.filter(e => e.followUp3Sent).length;
                        const totalEmails = windowedSent.length + fuSent + fu2Sent + fu3Sent;
                        const prevTotalEmails = prevWindowSent.length + prevWindowSent.filter(e=>e.followUpSent).length + prevWindowSent.filter(e=>e.followUp2Sent).length + prevWindowSent.filter(e=>e.followUp3Sent).length;
                        const orgsContacted = [...new Set(windowedSent.map(e => e.organization))].length;
                        const prevOrgsContacted = [...new Set(prevWindowSent.map(e => e.organization))].length;
                        const repliedEntries = windowedSent.filter(e => e.repliedAt);
                        const replyRate = windowedSent.length > 0 ? Math.round((repliedEntries.length / windowedSent.length) * 100) : 0;
                        const prevReplied = prevWindowSent.filter(e => e.repliedAt).length;
                        const prevReplyRate = prevWindowSent.length > 0 ? Math.round((prevReplied / prevWindowSent.length) * 100) : 0;
                        const inPipelineCount = visibleEntries.filter(e => ["Prospecting","Discovery","Proposal"].includes(e.stage)).length;

                        // ── Trend helper ─────────────────────────────────────────────────────
                        const trend = (cur: number, prev: number) => {
                          if (prev === 0) return { label: "—", color: MUTED };
                          const pct = Math.round(((cur - prev) / prev) * 100);
                          if (pct > 0) return { label: `↑ ${pct}% vs prev period`, color: SUCCESS };
                          if (pct < 0) return { label: `↓ ${Math.abs(pct)}% vs prev period`, color: ERROR };
                          return { label: "→ flat vs prev period", color: MUTED };
                        };

                        // ── Weekly volume buckets (8 weeks) ─────────────────────────────────
                        const weekBuckets: number[] = Array(8).fill(0);
                        sentEntries.forEach(e => {
                          if (!e.dateSent) return;
                          const daysAgo = Math.floor((now.getTime() - new Date(e.dateSent).getTime()) / 86400000);
                          const bucket = 7 - Math.floor(daysAgo / 7);
                          if (bucket >= 0 && bucket < 8) weekBuckets[bucket]++;
                        });
                        const maxWeekly = Math.max(...weekBuckets, 1);

                        // ── Conversion funnel ────────────────────────────────────────────────
                        const funnelBase = windowedSent.length || 1;
                        const fuSentCount = windowedSent.filter(e => e.followUpSent).length;
                        const proposalCount = windowedSent.filter(e => e.stage === "Proposal").length;
                        const wonCount = windowedSent.filter(e => e.stage === "Closed Won").length;

                        // ── Pipeline stages ──────────────────────────────────────────────────
                        const stageBreakdown = STAGES.map(s => ({ stage: s, count: visibleEntries.filter(e => e.stage === s).length }));
                        const stageMax = Math.max(...stageBreakdown.map(s => s.count), 1);

                        // ── Reply rate by SMERF category ─────────────────────────────────────
                        const catStats: Record<string, { sent: number; replied: number }> = {};
                        windowedSent.forEach(e => {
                          const cat = e.smerfCategory || "Other";
                          if (!catStats[cat]) catStats[cat] = { sent: 0, replied: 0 };
                          catStats[cat].sent++;
                          if (e.repliedAt) catStats[cat].replied++;
                        });
                        const catRates = Object.entries(catStats)
                          .map(([cat, { sent, replied }]) => ({ cat, rate: sent > 0 ? Math.round((replied/sent)*100) : 0, sent }))
                          .filter(r => r.sent >= 2)
                          .sort((a,b) => b.rate - a.rate)
                          .slice(0, 6);
                        const maxRate = Math.max(...catRates.map(r => r.rate), 1);

                        // ── Recent activity feed ─────────────────────────────────────────────
                        type ActivityItem = { text: string; time: string; color: string; ts: number };
                        const activity: ActivityItem[] = [];
                        visibleEntries.forEach(e => {
                          if (e.repliedAt) activity.push({ text: `Reply — ${e.organization}`, time: new Date(e.repliedAt).toLocaleDateString(), color: SUCCESS, ts: new Date(e.repliedAt).getTime() });
                          if (e.dateSent) activity.push({ text: `Sent to ${e.organization}`, time: new Date(e.dateSent).toLocaleDateString(), color: ACCENT, ts: new Date(e.dateSent).getTime() });
                        });
                        activity.sort((a,b) => b.ts - a.ts);
                        const recentActivity = activity.slice(0, 6);

                        // ── Discovery metrics ────────────────────────────────────────────────
                        const discPending = discoveryAll.filter(d => d.status === "pending").length;
                        const discSent = discoveryAll.filter(d => d.status === "sent").length;
                        const discWrongOrg = discoveryAll.filter(d => d.dismiss_reason === "wrong_org").length;
                        const discBadDraft = discoveryAll.filter(d => d.dismiss_reason === "bad_draft").length;
                        const discCustomer = discoveryAll.filter(d => d.dismiss_reason === "engine_customer").length;
                        const discDismissed = discoveryAll.filter(d => d.status === "dismissed").length;
                        const discTotal30d = discoveryAll.filter(d => d.created_at && d.created_at.slice(0,10) >= thirtyDaysAgo).length;
                        const discPrev30d = discoveryAll.filter(d => d.created_at && d.created_at.slice(0,10) >= new Date(Date.now()-60*86400000).toISOString().slice(0,10) && d.created_at.slice(0,10) < thirtyDaysAgo).length;
                        const discCatCounts: Record<string, number> = {};
                        discoveryAll.filter(d => d.status === "sent").forEach(d => { if (d.org_type) discCatCounts[d.org_type] = (discCatCounts[d.org_type] || 0) + 1; });
                        const topDiscCats = Object.entries(discCatCounts).sort((a,b) => b[1]-a[1]).slice(0, 5);
                        const maxDisc = topDiscCats[0]?.[1] || 1;
                        const maxDismissal = Math.max(discWrongOrg, discBadDraft, discCustomer, 1);
                        // Weekly discovery buckets (8 weeks)
                        const discWeekBuckets: number[] = Array(8).fill(0);
                        discoveryAll.forEach(d => {
                          if (!d.created_at) return;
                          const daysAgo = Math.floor((now.getTime() - new Date(d.created_at).getTime()) / 86400000);
                          const bucket = 7 - Math.floor(daysAgo / 7);
                          if (bucket >= 0 && bucket < 8) discWeekBuckets[bucket]++;
                        });
                        const maxDiscWeekly = Math.max(...discWeekBuckets, 1);

                        // ── Shared helpers ────────────────────────────────────────────────────
                        const BarChart = ({ rows, max, color }: { rows: [string, number][]; max: number; color: string }) => (
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            {rows.length === 0 ? <div style={{ fontSize: 12, color: MUTED, padding: "8px 0" }}>No data yet</div>
                            : rows.map(([label, count], i) => (
                              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <div style={{ fontSize: 11, color: TEXT, width: 120, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</div>
                                <div style={{ flex: 1, height: 7, background: BORDER, borderRadius: 4, overflow: "hidden" }}>
                                  <div style={{ width: `${Math.round((count / max) * 100)}%`, height: "100%", background: color, borderRadius: 4 }} />
                                </div>
                                <div style={{ fontSize: 11, color: TEXT_SECONDARY, width: 20, textAlign: "right", flexShrink: 0 }}>{count}</div>
                              </div>
                            ))}
                          </div>
                        );

                        // Sparkline helper — renders as inline SVG
                        const Sparkline = ({ buckets, max, color, height = 48 }: { buckets: number[]; max: number; color: string; height?: number }) => {
                          const w = 300; const h = height; const n = buckets.length;
                          const pts = buckets.map((v, i) => `${Math.round((i / (n-1)) * w)},${Math.round(h - (v / max) * (h - 4) - 2)}`).join(" ");
                          const area = `${pts} ${w},${h} 0,${h}`;
                          return (
                            <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height, overflow: "visible" }}>
                              <polygon points={area} fill={color} opacity={0.12} />
                              <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                              <circle cx={Math.round(((n-1)/(n-1))*w)} cy={Math.round(h - (buckets[n-1] / max) * (h-4) - 2)} r="3" fill={color} />
                            </svg>
                          );
                        };

                        return (
                          <>
                            {/* ── Date range selector ────────────────────────────────────────── */}
                            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 20 }}>
                              <span style={{ fontSize: 11, color: MUTED, marginRight: 4 }}>Showing</span>
                              {(["7d","30d","90d","all"] as const).map(r => (
                                <button key={r} onClick={() => setDashRange(r)}
                                  style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: `1px solid ${dashRange === r ? ACCENT : BORDER}`, background: dashRange === r ? "rgba(253,75,35,0.08)" : "transparent", color: dashRange === r ? ACCENT : MUTED, cursor: "pointer", fontFamily: "inherit", fontWeight: dashRange === r ? 600 : 400 }}>
                                  {r === "all" ? "All time" : r}
                                </button>
                              ))}
                            </div>

                            {/* ── Row 1: Metric cards with trend indicators ──────────────────── */}
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
                              {[
                                { label: "Emails sent", value: totalEmails, t: trend(totalEmails, prevTotalEmails), sub: `${windowedSent.length} initial + ${fuSent+fu2Sent+fu3Sent} follow-ups` },
                                { label: "Orgs contacted", value: orgsContacted, t: trend(orgsContacted, prevOrgsContacted), sub: "unique orgs" },
                                { label: "Reply rate", value: `${replyRate}%`, t: trend(replyRate, prevReplyRate), sub: `${repliedEntries.length} replies` },
                                { label: "Active pipeline", value: inPipelineCount, t: { label: overdueEntries.length > 0 ? `⚠ ${overdueEntries.length} overdue` : "no overdue", color: overdueEntries.length > 0 ? ERROR : SUCCESS }, sub: "Prospecting + Discovery + Proposal" },
                              ].map((m, i) => (
                                <div key={i} style={{ background: SURFACE, borderRadius: 10, padding: "14px 16px", border: `1px solid ${BORDER}` }}>
                                  <div style={{ fontSize: 11, color: MUTED, marginBottom: 4 }}>{m.label}</div>
                                  <div style={{ fontSize: 26, fontWeight: 700, color: TEXT, letterSpacing: "-0.02em", marginBottom: 4 }}>{m.value}</div>
                                  <div style={{ fontSize: 10, color: m.t.color, fontWeight: 500, marginBottom: 2 }}>{m.t.label}</div>
                                  <div style={{ fontSize: 10, color: MUTED }}>{m.sub}</div>
                                </div>
                              ))}
                            </div>

                            {/* ── Row 2: Volume trend + Conversion funnel ────────────────────── */}
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
                              <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 16px" }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Email volume — 8 weeks</div>
                                <Sparkline buckets={weekBuckets} max={maxWeekly} color={ACCENT} height={52} />
                                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: MUTED, marginTop: 4 }}>
                                  <span>8 weeks ago</span><span>This week</span>
                                </div>
                              </div>
                              <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 16px" }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Conversion funnel</div>
                                {[
                                  { label: "Initial sent", val: windowedSent.length, pct: 100, color: ACCENT },
                                  { label: "Follow-up sent", val: fuSentCount, pct: Math.round((fuSentCount/funnelBase)*100), color: ACCENT },
                                  { label: "Reply received", val: repliedEntries.length, pct: replyRate, color: SUCCESS },
                                  { label: "Proposal stage", val: proposalCount, pct: Math.round((proposalCount/funnelBase)*100), color: INFO },
                                  { label: "Closed won", val: wonCount, pct: Math.round((wonCount/funnelBase)*100), color: "#1D9E75" },
                                ].map(({ label, val, pct, color }, i) => (
                                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: i < 4 ? `1px solid ${BORDER}` : "none" }}>
                                    <span style={{ fontSize: 11, color: TEXT_SECONDARY, width: 90, flexShrink: 0 }}>{label}</span>
                                    <div style={{ flex: 1, height: 7, background: BORDER, borderRadius: 4, overflow: "hidden" }}>
                                      <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 4 }} />
                                    </div>
                                    <span style={{ fontSize: 11, color, fontWeight: 600, width: 32, textAlign: "right", flexShrink: 0 }}>{val > 0 ? `${pct}%` : "—"}</span>
                                  </div>
                                ))}
                              </div>
                            </div>

                            {/* ── Row 3: Pipeline stages + Reply by category + Activity feed ─── */}
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 24 }}>
                              {/* Pipeline stages */}
                              <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 16px" }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Pipeline stages</div>
                                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                  {stageBreakdown.map(({ stage, count }, i) => {
                                    const sc = STAGE_COLORS[stage as DealStage];
                                    return (
                                      <button key={i}
                                        onClick={() => { setLogFilter(logFilter === stage ? "all" : stage as DealStage); setReportSubTab("log"); }}
                                        style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 7, border: `1px solid ${logFilter === stage ? (sc?.text||BORDER) : "transparent"}`, background: logFilter === stage ? (sc?.bg||BG) : "transparent", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                                        <div style={{ width: 7, height: 7, borderRadius: "50%", background: sc?.text || MUTED, flexShrink: 0 }} />
                                        <span style={{ fontSize: 11, color: TEXT, flex: 1 }}>{stage}</span>
                                        <div style={{ width: 60, height: 5, background: BORDER, borderRadius: 3, overflow: "hidden" }}>
                                          <div style={{ width: `${Math.round((count/stageMax)*100)}%`, height: "100%", background: sc?.text||MUTED, borderRadius: 3 }} />
                                        </div>
                                        <span style={{ fontSize: 11, color: TEXT_SECONDARY, width: 18, textAlign: "right" }}>{count}</span>
                                      </button>
                                    );
                                  })}
                                </div>
                                <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${BORDER}`, fontSize: 10, color: MUTED }}>Click any stage to filter Activity Log</div>
                              </div>

                              {/* Reply rate by category */}
                              <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 16px" }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Reply rate by category</div>
                                {catRates.length === 0 ? (
                                  <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.6 }}>Send to 2+ orgs per category to see rates here.</div>
                                ) : (
                                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                                    {catRates.map(({ cat, rate, sent }, i) => (
                                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                        <div style={{ fontSize: 11, color: TEXT, width: 100, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cat}</div>
                                        <div style={{ flex: 1, height: 6, background: BORDER, borderRadius: 3, overflow: "hidden" }}>
                                          <div style={{ width: `${Math.round((rate/maxRate)*100)}%`, height: "100%", background: rate > 10 ? SUCCESS : rate > 5 ? INFO : MUTED, borderRadius: 3 }} />
                                        </div>
                                        <span style={{ fontSize: 11, color: rate > 10 ? SUCCESS : rate > 5 ? INFO : MUTED, width: 28, textAlign: "right", flexShrink: 0, fontWeight: 600 }}>{rate}%</span>
                                      </div>
                                    ))}
                                    {catRates.length > 0 && (
                                      <div style={{ marginTop: 6, fontSize: 10, color: MUTED, lineHeight: 1.5 }}>
                                        {catRates[0].rate > catRates[catRates.length-1].rate * 2 ? `${catRates[0].cat} replies ${Math.round(catRates[0].rate/Math.max(catRates[catRates.length-1].rate,1))}× more than ${catRates[catRates.length-1].cat}` : "Rates are relatively even across categories"}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>

                              {/* Recent activity feed */}
                              <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 16px" }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Recent activity</div>
                                {recentActivity.length === 0 ? (
                                  <div style={{ fontSize: 12, color: MUTED }}>No activity yet</div>
                                ) : (
                                  <div style={{ display: "flex", flexDirection: "column" }}>
                                    {recentActivity.map((a, i) => (
                                      <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 0", borderBottom: i < recentActivity.length-1 ? `1px solid ${BORDER}` : "none" }}>
                                        <div style={{ width: 6, height: 6, borderRadius: "50%", background: a.color, marginTop: 4, flexShrink: 0 }} />
                                        <div style={{ flex: 1, fontSize: 11, color: TEXT_SECONDARY, lineHeight: 1.4 }}>{a.text}</div>
                                        <div style={{ fontSize: 10, color: MUTED, flexShrink: 0 }}>{a.time}</div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* ── Divider ────────────────────────────────────────────────────── */}
                            <div style={{ height: 1, background: BORDER, marginBottom: 24 }} />

                            {/* ── Section: Daily Discovery (preserved) ────────────────────── */}
                            <div>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.06em" }}>Daily Discovery</div>
                                {!discoveryAllLoaded && <div style={{ fontSize: 11, color: MUTED }}>Loading...</div>}
                                {discoveryAllLoaded && <button onClick={() => { setDiscoveryAllLoaded(false); loadDiscoveryAll(); }} style={{ fontSize: 11, color: MUTED, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", marginLeft: "auto" }}>↻ Refresh</button>}
                              </div>

                              {/* Discovery metrics */}
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
                                {[
                                  { label: "Discovered (30d)", value: discTotal30d, t: trend(discTotal30d, discPrev30d), sub: "3 orgs/day target" },
                                  { label: "Sent", value: discSent, t: { label: discTotal30d > 0 ? `${Math.round((discSent/Math.max(discoveryAll.length,1))*100)}% send rate` : "—", color: MUTED }, sub: "from discovery" },
                                  { label: "Dismissed", value: discDismissed, t: { label: `${discCustomer} customer · ${discWrongOrg} wrong org · ${discBadDraft} bad draft`, color: MUTED }, sub: "total dismissed" },
                                  { label: "Pending Review", value: discPending, t: { label: discPending > 5 ? "review backlog building" : "inbox healthy", color: discPending > 5 ? ERROR : SUCCESS }, sub: "waiting in Follow-Ups" },
                                ].map((m, i) => (
                                  <div key={i} style={{ background: SURFACE, borderRadius: 10, padding: "14px 16px", border: `1px solid ${BORDER}` }}>
                                    <div style={{ fontSize: 11, color: MUTED, marginBottom: 4 }}>{m.label}</div>
                                    <div style={{ fontSize: 26, fontWeight: 700, color: TEXT, letterSpacing: "-0.02em", marginBottom: 4 }}>{m.value}</div>
                                    <div style={{ fontSize: 10, color: m.t.color, fontWeight: 500, marginBottom: 2 }}>{m.t.label}</div>
                                    <div style={{ fontSize: 10, color: MUTED }}>{m.sub}</div>
                                  </div>
                                ))}
                              </div>

                              {/* Discovery volume sparkline */}
                              <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 16px", marginBottom: 12 }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Discovery volume — 8 weeks</div>
                                <Sparkline buckets={discWeekBuckets} max={maxDiscWeekly} color={INFO} height={44} />
                                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: MUTED, marginTop: 4 }}>
                                  <span>8 weeks ago</span><span>This week</span>
                                </div>
                              </div>

                              {/* Top org types + Dismissal reasons */}
                              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                                <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 16px" }}>
                                  <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>Top org types sent</div>
                                  <BarChart rows={topDiscCats} max={maxDisc} color={INFO} />
                                  {topDiscCats.length === 0 && <div style={{ fontSize: 12, color: MUTED }}>Send discovery emails to see which org types are working</div>}
                                </div>
                                <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 16px" }}>
                                  <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>Dismissal reasons</div>
                                  {discDismissed === 0 ? <div style={{ fontSize: 12, color: MUTED }}>No dismissals yet</div> : (
                                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                      {[
                                        { label: "Engine customer", count: discCustomer, color: SUCCESS },
                                        { label: "Wrong org", count: discWrongOrg, color: MUTED },
                                        { label: "Bad draft", count: discBadDraft, color: INFO },
                                      ].map(({ label, count, color }, i) => (
                                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                          <div style={{ fontSize: 11, color: TEXT, width: 100, flexShrink: 0 }}>{label}</div>
                                          <div style={{ flex: 1, height: 7, background: BORDER, borderRadius: 4, overflow: "hidden" }}>
                                            <div style={{ width: `${Math.round((count/maxDismissal)*100)}%`, height: "100%", background: color, borderRadius: 4 }} />
                                          </div>
                                          <div style={{ fontSize: 11, color: TEXT_SECONDARY, width: 20, textAlign: "right" }}>{count}</div>
                                        </div>
                                      ))}
                                      <div style={{ marginTop: 8, fontSize: 11, color: MUTED, lineHeight: 1.5 }}>
                                        {discCustomer > 2 ? `${discCustomer} Engine customers caught — consider uploading a customer exclusion list.` : discWrongOrg > discBadDraft * 2 ? "High wrong org rate — tighten your segment focus in Settings." : discBadDraft > discWrongOrg ? "High bad draft rate — orgs are right but emails need refinement." : "Looking balanced."}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  ) : reportSubTab === "followups" ? (
                    /* Follow-Up Queue */
                    <div>
                      {/* ── Replies Detected section ──────────────────────── */}
                      {(() => {
                        const repliedEntries = visibleEntries.filter(e => e.repliedAt);
                        if (!repliedEntries.length) return null;
                        return (
                          <div style={{ marginBottom: 32 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                              <span style={{ fontSize: 11, fontWeight: 700, color: SUCCESS, textTransform: "uppercase", letterSpacing: "0.06em" }}>💬 Replies Detected</span>
                              <span style={{ fontSize: 11, color: MUTED }}>— {repliedEntries.length} prospect{repliedEntries.length !== 1 ? "s" : ""} replied · stage moved to Discovery</span>
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                              {repliedEntries.map(entry => (
                                <div key={entry.id} style={{ background: "rgba(0,146,98,0.03)", border: `1px solid rgba(0,146,98,0.25)`, borderRadius: 10, padding: "14px 16px", borderLeft: `3px solid ${SUCCESS}` }}>
                                  <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                                        <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: SUCCESS, color: "#fff", letterSpacing: "0.06em", textTransform: "uppercase" }}>✓ Replied</span>
                                        <span style={{ fontSize: 14, fontWeight: 600, color: TEXT }}>{entry.contactName}</span>
                                        <span style={{ fontSize: 13, color: TEXT_SECONDARY }}>·</span>
                                        <span style={{ fontSize: 13, color: TEXT_SECONDARY }}>{entry.organization}</span>
                                        <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 20, background: "rgba(20,118,216,0.1)", color: "#1476D8" }}>Discovery</span>
                                      </div>
                                      {entry.replySnippet && (
                                        <div style={{ fontSize: 12, color: TEXT_SECONDARY, fontStyle: "italic", lineHeight: 1.5, marginTop: 4, padding: "8px 12px", background: "rgba(0,146,98,0.06)", borderRadius: 6, borderLeft: `2px solid ${SUCCESS}` }}>
                                          "{entry.replySnippet.slice(0, 200)}{entry.replySnippet.length > 200 ? "…" : ""}"
                                        </div>
                                      )}
                                      <div style={{ fontSize: 11, color: MUTED, marginTop: 6 }}>
                                        Detected {entry.repliedAt ? new Date(entry.repliedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""} · {entry.email}
                                      </div>
                                    </div>
                                    <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                                      <a
                                        href={`https://mail.google.com/mail/#search/from%3A${encodeURIComponent(entry.email)}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        style={{ padding: "7px 14px", background: SUCCESS, color: "#fff", border: "none", borderRadius: 7, fontFamily: "inherit", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", textDecoration: "none", display: "inline-block" }}>
                                        View in Gmail →
                                      </a>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })()}
                      {/* ── Discovered This Morning section ──────────────── */}
                      {autoDrafts.length > 0 && (
                        <div style={{ marginBottom: 32 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: ACCENT, textTransform: "uppercase", letterSpacing: "0.06em" }}>⚡ Discovered This Morning</span>
                            <span style={{ fontSize: 11, color: MUTED }}>— {autoDrafts.length} new org{autoDrafts.length !== 1 ? "s" : ""} found & drafted</span>
                            <button onClick={() => { setAutoDraftsLoaded(false); loadAutoDrafts(); }} style={{ marginLeft: "auto", fontSize: 11, color: MUTED, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>↻ Refresh</button>
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            {autoDrafts.map(draft => (
                              <div key={draft.id} style={{ background: "rgba(253,75,35,0.02)", border: `1px solid rgba(253,75,35,0.2)`, borderRadius: 10, padding: "14px 16px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)", borderLeft: `3px solid ${ACCENT}` }}>
                                <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    {/* Daily Discovery label — always visible on the card */}
                                    <div style={{ display: "inline-flex", alignItems: "center", gap: 5, marginBottom: 7, padding: "2px 8px", borderRadius: 20, background: ACCENT }}>
                                      <span style={{ fontSize: 9, fontWeight: 700, color: ACCENT_TEXT, letterSpacing: "0.07em", textTransform: "uppercase" }}>⚡ Daily Discovery · Step 1</span>
                                    </div>
                                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                                      <span style={{ fontSize: 14, fontWeight: 600, color: TEXT }}>{draft.contact_name || "Contact"}</span>
                                      <span style={{ fontSize: 13, color: TEXT_SECONDARY }}>·</span>
                                      <span style={{ fontSize: 13, color: TEXT_SECONDARY }}>{draft.org_name}</span>
                                      {draft.org_type && <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 20, background: "rgba(253,75,35,0.08)", color: ACCENT }}>{draft.org_type}</span>}
                                    </div>
                                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
                                      {draft.contact_title && <span style={{ fontSize: 11, color: MUTED }}>{draft.contact_title}</span>}
                                      {editingAdEmail === draft.id ? (
                                        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                                          <input
                                            autoFocus
                                            type="email"
                                            value={adEmailText}
                                            onChange={e => setAdEmailText(e.target.value)}
                                            onKeyDown={e => { if (e.key === "Enter") saveAdEmail(draft.id); if (e.key === "Escape") { setEditingAdEmail(null); setAdEmailText(""); } }}
                                            placeholder="Enter email address"
                                            style={{ fontSize: 11, padding: "3px 8px", border: `1px solid ${ACCENT}`, borderRadius: 6, fontFamily: "inherit", outline: "none", width: 200, color: TEXT, background: SURFACE }}
                                          />
                                          <button onClick={() => saveAdEmail(draft.id)}
                                            style={{ fontSize: 10, fontWeight: 600, padding: "3px 9px", background: ACCENT, color: ACCENT_TEXT, border: "none", borderRadius: 6, cursor: "pointer", fontFamily: "inherit" }}>
                                            Save
                                          </button>
                                          <button onClick={() => { setEditingAdEmail(null); setAdEmailText(""); }}
                                            style={{ fontSize: 10, padding: "3px 7px", background: "none", color: MUTED, border: `1px solid ${BORDER}`, borderRadius: 6, cursor: "pointer", fontFamily: "inherit" }}>
                                            Cancel
                                          </button>
                                        </span>
                                      ) : draft.contact_email ? (
                                        <button onClick={() => { setEditingAdEmail(draft.id); setAdEmailText(draft.contact_email); }}
                                          title={draft.contact_email_verified ? `Source: ${draft.contact_source || "found"} — click to edit` : `Unverified (${draft.contact_source || "constructed"}) — click to correct`}
                                          style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 20, background: draft.contact_email_verified ? "rgba(0,146,98,0.08)" : "rgba(255,152,0,0.12)", color: draft.contact_email_verified ? SUCCESS : "#E65100", border: "none", cursor: "pointer", fontFamily: "inherit" }}>
                                          {draft.contact_email_verified ? "✓" : "⚠"} {draft.contact_email}
                                        </button>
                                      ) : (
                                        <button onClick={() => { setEditingAdEmail(draft.id); setAdEmailText(""); }}
                                          title="Click to add email address — the draft stays here until you send or dismiss it"
                                          style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 20, background: "rgba(229,57,53,0.1)", color: ERROR, border: "none", cursor: "pointer", fontFamily: "inherit" }}>
                                          ✕ No email — click to add
                                        </button>
                                      )}
                                    </div>
                                    {draft.website && (
                                      <a href={draft.website.startsWith("http") ? draft.website : `https://${draft.website}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: INFO, textDecoration: "none", display: "inline-block", marginBottom: 4 }}>
                                        🌐 {draft.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                                      </a>
                                    )}
                                    <div style={{ fontSize: 12, fontWeight: 600, color: TEXT, marginBottom: 4 }}>Subject: {draft.subject}</div>
                                    <div style={{ fontSize: 12, color: TEXT_SECONDARY, whiteSpace: "pre-wrap", lineHeight: 1.5, maxHeight: 80, overflow: "hidden", WebkitMaskImage: "linear-gradient(to bottom, black 60%, transparent 100%)" }}>{draft.body}</div>
                                  </div>
                                  <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                                    <button
                                      onClick={() => {
                                        if (!draft.contact_email) { setEditingAdEmail(draft.id); setAdEmailText(""); return; }
                                        const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(draft.contact_email)}&su=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
                                        window.open(gmailUrl, "_blank");
                                        // Mark auto_draft as sent
                                        fetch("/api/discover", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: draft.id, status: "sent" }) });
                                        // Create a report_entry so it appears in Activity Log tagged as Daily Discovery
                                        const today = new Date();
                                        const fu1 = new Date(today); fu1.setDate(today.getDate() + 5);
                                        const fu2 = new Date(today); fu2.setDate(today.getDate() + 9);
                                        const fu3 = new Date(today); fu3.setDate(today.getDate() + 15);
                                        const newEntry: ReportEntry = {
                                          id: crypto.randomUUID(),
                                          repName: styleProfile?.repName || "",
                                          wave: waveNumber,
                                          smerfCategory: draft.org_type || "SMERF",
                                          organization: draft.org_name,
                                          contactName: draft.contact_name,
                                          title: draft.contact_title,
                                          email: draft.contact_email,
                                          subjectLine: draft.subject,
                                          dateSent: today.toISOString().slice(0, 10),
                                          status: "Sent",
                                          stage: "Outreach" as DealStage,
                                          followUpDue: fu1.toISOString().slice(0, 10),
                                          followUpSent: false,
                                          followUp2Due: fu2.toISOString().slice(0, 10),
                                          followUp2Sent: false,
                                          followUp3Due: fu3.toISOString().slice(0, 10),
                                          followUp3Sent: false,
                                          notes: draft.website ? `Website: ${draft.website}` : "",
                                          source: "Daily Discovery",
                                        };
                                        fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(newEntry) });
                                        setReportEntries(prev => [newEntry, ...prev]);
                                        setAutoDrafts(prev => prev.filter(d => d.id !== draft.id));
                                      }}
                                      style={{ padding: "7px 14px", background: ACCENT, color: ACCENT_TEXT, border: "none", borderRadius: 7, fontFamily: "inherit", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                                      ✉ Send in Gmail
                                    </button>
                                    <button
                                      onClick={async () => {
                                        await fetch("/api/discover", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: draft.id, status: "dismissed", dismiss_reason: "engine_customer" }) });
                                        setAutoDrafts(prev => prev.filter(d => d.id !== draft.id));
                                      }}
                                      title="Engine Customer — permanently skip this org, they're already a customer"
                                      style={{ padding: "7px 14px", background: "none", color: SUCCESS, border: `1px solid ${SUCCESS}`, borderRadius: 7, fontFamily: "inherit", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" }}>
                                      ✓ Customer
                                    </button>
                                    <button
                                      onClick={async () => {
                                        await fetch("/api/discover", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: draft.id, status: "dismissed", dismiss_reason: "wrong_org" }) });
                                        setAutoDrafts(prev => prev.filter(d => d.id !== draft.id));
                                      }}
                                      title="Wrong org — exclude this org permanently from discovery"
                                      style={{ padding: "7px 14px", background: "none", color: MUTED, border: `1px solid ${BORDER}`, borderRadius: 7, fontFamily: "inherit", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" }}>
                                      ✕ Wrong org
                                    </button>
                                    <button
                                      onClick={async () => {
                                        await fetch("/api/discover", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: draft.id, status: "dismissed", dismiss_reason: "bad_draft" }) });
                                        setAutoDrafts(prev => prev.filter(d => d.id !== draft.id));
                                      }}
                                      title="Bad draft — org is still valid, rediscover with a better email tomorrow"
                                      style={{ padding: "7px 14px", background: "none", color: INFO, border: `1px solid ${INFO}`, borderRadius: 7, fontFamily: "inherit", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" }}>
                                      ↻ Bad draft
                                    </button>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {/* ── Pre-drafted by Agent section ─────────────────── */}
                      {preDrafts.length > 0 && (
                        <div style={{ marginBottom: 32 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: SUCCESS, textTransform: "uppercase", letterSpacing: "0.06em" }}>⚡ Pre-drafted by Agent</span>
                            <span style={{ fontSize: 11, color: MUTED }}>— {preDrafts.length} ready to send</span>
                            <button onClick={() => { setPreDraftsLoaded(false); loadPreDrafts(); }} style={{ marginLeft: "auto", fontSize: 11, color: MUTED, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>↻ Refresh</button>
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            {preDrafts.map(draft => (
                              <div key={draft.id} style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 16px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)", borderLeft: `3px solid ${SUCCESS}` }}>
                                <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                                      <span style={{ fontSize: 14, fontWeight: 600, color: TEXT }}>{draft.entry?.contact_name || "Contact"}</span>
                                      <span style={{ fontSize: 13, color: TEXT_SECONDARY }}>·</span>
                                      <span style={{ fontSize: 13, color: TEXT_SECONDARY }}>{draft.entry?.organization || ""}</span>
                                      <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "rgba(0,146,98,0.1)", color: SUCCESS }}>FU {draft.fu_num}</span>
                                    </div>
                                    <div style={{ fontSize: 12, fontWeight: 600, color: TEXT, marginBottom: 4 }}>Subject: {draft.subject}</div>
                                    <div style={{ fontSize: 12, color: TEXT_SECONDARY, whiteSpace: "pre-wrap", lineHeight: 1.5, maxHeight: 80, overflow: "hidden", WebkitMaskImage: "linear-gradient(to bottom, black 60%, transparent 100%)" }}>{draft.body}</div>
                                  </div>
                                  <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                                    <button
                                      onClick={() => {
                                        // Open the draft in the existing follow-up preview modal
                                        const matchEntry = reportEntries.find(e => e.id === draft.entry_id);
                                        if (matchEntry) {
                                          const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(matchEntry.email)}&su=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
                                          setFollowUpEditedBody(draft.body);
                                          setPreDraftIdInModal(draft.id);
                                          setFollowUpPreview({ entry: matchEntry, subject: draft.subject, body: draft.body, gmailUrl, fuNum: draft.fu_num as 1 | 2 | 3 });
                                        }
                                      }}
                                      style={{ padding: "7px 14px", background: SUCCESS, color: "#fff", border: "none", borderRadius: 7, fontFamily: "inherit", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                                      ✉ Review &amp; Send
                                    </button>
                                    <button
                                      onClick={async () => {
                                        await fetch("/api/followups", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: draft.id, status: "dismissed" }) });
                                        setPreDrafts(prev => prev.filter(d => d.id !== draft.id));
                                      }}
                                      style={{ padding: "7px 14px", background: "none", color: MUTED, border: `1px solid ${BORDER}`, borderRadius: 7, fontFamily: "inherit", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" }}>
                                      Dismiss
                                    </button>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {/* ── Due / Overdue sections ─────────────────────────── */}
                      {(() => {
                        const allDue = [...overdueEntries, ...dueThisWeek];
                        if (allDue.length === 0 && preDrafts.length === 0 && autoDrafts.length === 0) return (
                          <div style={{ padding: "80px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                            <div style={{ fontSize: 40, opacity: 0.2 }}>✅</div>
                            <div style={{ fontSize: 15, fontWeight: 600, color: TEXT }}>All caught up</div>
                            <div style={{ fontSize: 13, color: MUTED }}>No follow-ups overdue or due this week</div>
                          </div>
                        );
                        if (allDue.length === 0) return null;
                        const sections: Array<{ label: string; entries: ReportEntry[]; color: string; bg: string; icon: string }> = [];
                        if (overdueEntries.length > 0) sections.push({ label: "Overdue", entries: overdueEntries, color: ACCENT, bg: "rgba(253,75,35,0.06)", icon: "⚠" });
                        if (dueThisWeek.length > 0) sections.push({ label: "Due This Week", entries: dueThisWeek, color: INFO, bg: "rgba(20,118,216,0.05)", icon: "📅" });
                        return sections.map(section => (
                          <div key={section.label} style={{ marginBottom: 28 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                              <span style={{ fontSize: 11, fontWeight: 700, color: section.color, textTransform: "uppercase", letterSpacing: "0.06em" }}>{section.icon} {section.label}</span>
                              <span style={{ fontSize: 11, color: MUTED }}>— {section.entries.length} contact{section.entries.length !== 1 ? "s" : ""}</span>
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                              {section.entries.map(entry => {
                                const nfu = nextFollowUp(entry);
                                if (!nfu) return null;
                                const daysUntil = (() => {
                                  try {
                                    const due = parseLocalDate(nfu.due);
                                    const today = new Date(); today.setHours(0,0,0,0);
                                    return Math.round((due.getTime() - today.getTime()) / 86400000);
                                  } catch { return 0; }
                                })();
                                const daysLabel = daysUntil < 0
                                  ? `${Math.abs(daysUntil)}d overdue`
                                  : daysUntil === 0 ? "Due today"
                                  : `Due in ${daysUntil}d`;
                                const isGenerating = generatingFollowUp === entry.id;
                                return (
                                  <div key={entry.id} style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 16px", display: "flex", alignItems: "center", gap: 14, boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
                                    <div style={{ width: 3, alignSelf: "stretch", borderRadius: 4, background: section.color, flexShrink: 0 }} />
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3, flexWrap: "wrap" }}>
                                        <span style={{ fontSize: 14, fontWeight: 600, color: TEXT }}>{entry.contactName}</span>
                                        <span style={{ fontSize: 13, color: TEXT_SECONDARY }}>·</span>
                                        <span style={{ fontSize: 13, color: TEXT_SECONDARY }}>{entry.organization}</span>
                                        <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 20, background: STAGE_COLORS[entry.stage]?.bg || BG, color: STAGE_COLORS[entry.stage]?.text || MUTED }}>{entry.stage}</span>
                                      </div>
                                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                                        <span style={{ fontSize: 11, color: MUTED }}>{entry.title}</span>
                                        {entry.title && entry.smerfCategory && <span style={{ fontSize: 10, color: MUTED }}>·</span>}
                                        <span style={{ fontSize: 11, color: MUTED }}>{entry.smerfCategory}</span>
                                        <span style={{ fontSize: 11, fontWeight: 600, color: section.color, background: section.bg, padding: "2px 8px", borderRadius: 20 }}>{nfu.label}</span>
                                        <span style={{ fontSize: 11, color: daysUntil < 0 ? ACCENT : TEXT_SECONDARY }}>{daysLabel}</span>
                                      </div>
                                    </div>
                                    <button
                                      onClick={() => generateFollowUp(entry, nfu.num as 1 | 2 | 3)}
                                      disabled={isGenerating}
                                      style={{ flexShrink: 0, padding: "8px 16px", background: isGenerating ? BORDER : section.color, color: isGenerating ? MUTED : "#fff", border: "none", borderRadius: 8, fontFamily: "inherit", fontSize: 12, fontWeight: 600, cursor: isGenerating ? "not-allowed" : "pointer", whiteSpace: "nowrap", transition: "opacity 0.15s" }}>
                                      {isGenerating ? "Drafting…" : `✍ Draft ${nfu.label}`}
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ));
                      })()}
                    </div>
                  ) : (
                    /* Activity Log */
                    <div>
                      {/* Active filter label */}
                      {logFilter !== "all" && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                          <span style={{ fontSize: 12, color: TEXT_SECONDARY }}>Showing:</span>
                          {(() => {
                            const isStage = (STAGES as readonly string[]).includes(logFilter);
                            const sc = isStage ? STAGE_COLORS[logFilter as DealStage] : null;
                            const label = logFilter === "overdue" ? `⚠ Overdue (${overdueEntries.length})`
                              : logFilter === "week" ? `📅 Due This Week (${dueThisWeek.length})`
                              : isStage ? `${logFilter} (${actionFilteredEntries.length})`
                              : logFilter;
                            return (
                              <span style={{ fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 20, background: sc ? sc.bg : logFilter === "overdue" ? "rgba(253,75,35,0.1)" : "rgba(20,118,216,0.1)", color: sc ? sc.text : logFilter === "overdue" ? ACCENT : INFO }}>
                                {label}
                              </span>
                            );
                          })()}
                          <button onClick={() => setLogFilter("all")} style={{ fontSize: 11, color: MUTED, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>× Clear</button>
                        </div>
                      )}
                      {/* Search bar */}
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                        <div style={{ position: "relative", flex: 1, maxWidth: 340 }}>
                          <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: MUTED, pointerEvents: "none" }}>🔍</span>
                          <input
                            value={logSearch}
                            onChange={e => setLogSearch(e.target.value)}
                            placeholder="Search org, contact, rep, category…"
                            style={{ width: "100%", paddingLeft: 32, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontSize: 13, background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 7, color: TEXT, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}
                          />
                        </div>
                        {logSearch && (
                          <button onClick={() => setLogSearch("")}
                            style={{ fontSize: 12, color: MUTED, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: "4px 8px" }}>
                            Clear
                          </button>
                        )}
                        {logSearch && (
                          <span style={{ fontSize: 12, color: TEXT_SECONDARY }}>
                            {actionFilteredEntries.filter(e =>
                              [e.organization, e.contactName, e.repName, e.smerfCategory, e.email]
                                .some(v => v.toLowerCase().includes(logSearch.toLowerCase()))
                            ).length} result{actionFilteredEntries.filter(e =>
                              [e.organization, e.contactName, e.repName, e.smerfCategory, e.email]
                                .some(v => v.toLowerCase().includes(logSearch.toLowerCase()))
                            ).length !== 1 ? "s" : ""}
                          </span>
                        )}
                      </div>
                    <div style={{ overflowX: "auto" }}>
                      <div style={{ display: "grid", gridTemplateColumns: "140px 120px 80px 140px 80px 90px 100px 1fr", gap: 0, background: BG, border: `1px solid ${BORDER}`, borderBottom: "none", borderRadius: "10px 10px 0 0", padding: "10px 14px", minWidth: 960 }}>
                        {["Organization", "Contact", "Rep", "Stage", "Status", "Date Sent", "Follow-Up", "Actions"].map((h, i) => (
                          <div key={i} style={{ fontSize: 11, fontWeight: 600, color: TEXT_SECONDARY, textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</div>
                        ))}
                      </div>
                      <div style={{ border: `1px solid ${BORDER}`, borderRadius: "0 0 10px 10px", overflow: "hidden", minWidth: 960 }}>
                        {(logSearch.trim()
                          ? actionFilteredEntries.filter(e =>
                              [e.organization, e.contactName, e.repName, e.smerfCategory, e.email]
                                .some(v => v.toLowerCase().includes(logSearch.toLowerCase()))
                            )
                          : actionFilteredEntries
                        ).map((entry, i, arr) => {
                          const overdue = isOverdue(entry);
                          const sc = STAGE_COLORS[entry.stage] || STAGE_COLORS["Discovery"];
                          const isDuplicate = duplicateOrgs.has(entry.organization);
                          return (
                            <div key={entry.id} style={{ display: "grid", gridTemplateColumns: "140px 120px 80px 140px 80px 90px 100px 1fr", gap: 0, padding: "10px 14px", borderBottom: i < arr.length - 1 ? `1px solid ${BORDER}` : "none", background: isDuplicate ? "rgba(124,58,237,0.03)" : overdue ? "rgba(253,75,35,0.03)" : i % 2 === 0 ? SURFACE : "rgba(248,246,242,0.5)", alignItems: "center" }}>
                              <div onMouseEnter={() => lookupCbOverlap(entry.organization)}>
                                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                  <div style={{ fontSize: 12, color: TEXT, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 4 }} title={entry.organization}>{entry.organization}</div>
                                  {entry.source === "Daily Discovery" && (
                                    <span title="Sourced by Daily Discovery cron" style={{ fontSize: 9, fontWeight: 700, color: ACCENT_TEXT, background: ACCENT, borderRadius: 10, padding: "1px 6px", whiteSpace: "nowrap", flexShrink: 0 }}>⚡ Discovery</span>
                                  )}
                                  {entry.repliedAt && (
                                    <span title={entry.replySnippet ? `Reply: "${entry.replySnippet.slice(0, 80)}…"` : "Prospect replied"} style={{ fontSize: 9, fontWeight: 700, color: "#fff", background: SUCCESS, borderRadius: 10, padding: "1px 6px", whiteSpace: "nowrap", flexShrink: 0, cursor: "default" }}>✓ Replied</span>
                                  )}
                                  {isDuplicate && <span title={`${orgCounts[entry.organization]} entries for this org`} style={{ fontSize: 9, fontWeight: 700, color: "#7C3AED", background: "rgba(124,58,237,0.1)", borderRadius: 10, padding: "1px 5px", whiteSpace: "nowrap", flexShrink: 0 }}>×{orgCounts[entry.organization]}</span>}
                                  {cbOverlaps[entry.organization]?.count > 0 && (
                                    <span
                                      title={`Partner overlap: ${cbOverlaps[entry.organization].partners.join(", ")}`}
                                      style={{ fontSize: 9, fontWeight: 700, color: "#0057D9", background: "rgba(0,87,217,0.1)", borderRadius: 10, padding: "1px 5px", whiteSpace: "nowrap", flexShrink: 0, cursor: "default" }}>
                                      🤝 {cbOverlaps[entry.organization].count}
                                    </span>
                                  )}
                                  {cbOverlaps[entry.organization]?.isCustomer && (
                                    <span style={{ fontSize: 9, fontWeight: 700, color: "#009262", background: "rgba(0,146,98,0.1)", borderRadius: 10, padding: "1px 5px", whiteSpace: "nowrap", flexShrink: 0 }}>
                                      ✓ Customer
                                    </span>
                                  )}
                                </div>
                                <div style={{ fontSize: 10, color: TEXT_SECONDARY, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 8 }} title={entry.contactName}>{entry.contactName}</div>
                              </div>
                              <div style={{ fontSize: 11, color: MUTED, paddingRight: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.repName || "—"}</div>
                              <div style={{ paddingRight: 8 }}>
                                <select
                                  value={entry.stage}
                                  onChange={ev => updateEntryStage(entry.id, ev.target.value as DealStage)}
                                  style={{ fontSize: 11, fontWeight: 600, color: sc.text, background: sc.bg, border: "none", borderRadius: 20, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit", outline: "none", width: "100%" }}>
                                  {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
                                </select>
                              </div>
                              <div>
                                <span style={{ fontSize: 10, padding: "3px 8px", borderRadius: 20, fontWeight: 600, background: entry.status === "Sent" ? "rgba(0,146,98,0.1)" : entry.status === "Fallback" ? "rgba(158,158,158,0.15)" : "rgba(20,118,216,0.1)", color: entry.status === "Sent" ? SUCCESS : entry.status === "Fallback" ? MUTED : INFO }}>
                                  {entry.status}
                                </span>
                              </div>
                              <div style={{ fontSize: 11, color: TEXT_SECONDARY }}>{fmtDate(entry.dateSent)}</div>
                              <div style={{ fontSize: 11, color: overdue ? ACCENT : entry.followUpDue ? TEXT_SECONDARY : MUTED, fontWeight: overdue ? 600 : 400 }}>
                                {overdue ? "⚠ Overdue" : entry.followUpSent ? "✓ Done" : fmtDate(entry.followUpDue)}
                              </div>
                              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                {(() => {
                                  // Check if org is engaged (another contact at same org moved past Prospecting)
                                  const orgEngaged = entry.stage === "Prospecting" && entry.status === "Sent" && reportEntries.some(e =>
                                    e.id !== entry.id &&
                                    e.organization === entry.organization &&
                                    e.stage !== "Prospecting"
                                  );
                                  if (orgEngaged) {
                                    const engagedStage = reportEntries.find(e =>
                                      e.id !== entry.id &&
                                      e.organization === entry.organization &&
                                      e.stage !== "Prospecting"
                                    )?.stage || "active";
                                    return <span style={{ fontSize: 10, color: INFO, background: "rgba(20,118,216,0.08)", padding: "3px 8px", borderRadius: 20, whiteSpace: "nowrap" }}>Org in {engagedStage}</span>;
                                  }
                                  const nfu = nextFollowUp(entry);
                                  if (overdue && nfu) return (
                                    <button
                                      onClick={() => generateFollowUp(entry, nfu.num)}
                                      disabled={generatingFollowUp === entry.id}
                                      style={{ fontSize: 11, fontWeight: 600, padding: "4px 10px", background: generatingFollowUp === entry.id ? BORDER : ACCENT, color: generatingFollowUp === entry.id ? MUTED : ACCENT_TEXT, border: "none", borderRadius: 6, cursor: generatingFollowUp === entry.id ? "not-allowed" : "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                                      {generatingFollowUp === entry.id ? "Drafting…" : `Draft ${nfu.label}`}
                                    </button>
                                  );
                                  if (entry.followUp3Sent) return <span style={{ fontSize: 10, color: MUTED }}>Sequence complete</span>;
                                  if (entry.followUp2Sent) return <span style={{ fontSize: 10, color: SUCCESS }}>FU 1–2 sent</span>;
                                  if (entry.followUpSent) return <span style={{ fontSize: 10, color: SUCCESS }}>FU 1 sent</span>;
                                  return null;
                                })()}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
        </>)}
      </div>
    </div>
  );
}
