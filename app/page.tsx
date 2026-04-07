"use client";

import { useState, useCallback, useEffect } from "react";

const ACCENT = "#f5c518";
const BG = "#0e0e0e";
const SURFACE = "#161616";
const BORDER = "#2a2a2a";
const MUTED = "#666";
const SUCCESS = "#4caf50";
const ERROR = "#f44336";
const INFO = "#60a5fa";

const FALLBACK_ROLES = ["Executive Director", "VP of Programs", "Director of Events"];

const STYLE_KEY = "engine-agent-style-v2";

interface Contact {
  name: string;
  title: string;
  company: string;
  email: string;
  source: string;
}

interface Draft {
  to: string;
  email: string;
  subject: string;
  body: string;
  sentAt: string | null;
  edited?: string; // stores rep's edited version
  research?: string; // AI research notes for this contact
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
}


function fallbackContacts(orgName: string): Contact[] {
  const names = ["Sarah Mitchell", "James Thornton", "Ana Rivera"];
  const domain = orgName.toLowerCase().replace(/[^a-z0-9]/g, "") + ".org";
  return names.map((name, i) => ({
    name, title: FALLBACK_ROLES[i] || "Director", company: orgName,
    email: name.split(" ")[0].toLowerCase() + "@" + domain, source: "Fallback",
  }));
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
function parseDraft(raw: string): { subject: string; body: string } | null {
  // Try JSON first
  const json = parseJSON(raw);
  if (json?.subject && json?.body) return {
    subject: stripEmDashes(json.subject),
    body: stripEmDashes(json.body),
  };

  // Try plain text: look for SUBJECT: line
  const subjectMatch = raw.match(/^SUBJECT:\s*(.+)$/im);
  if (subjectMatch) {
    const subject = subjectMatch[1].trim();
    // Body is everything after the subject line and following blank lines
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

async function callClaude(messages: { role: string; content: string }[], retries = 4): Promise<string> {
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (res.status === 429 && retries > 0) {
    const wait = (5 - retries) * 3000 + 2000; // 2s, 5s, 8s, 11s
    await new Promise(r => setTimeout(r, wait));
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
            <div style={{ position: "absolute", top: 11, left: "50%", width: "100%", height: 1, background: step.state === "done" ? ACCENT : BORDER, zIndex: 0 }} />
          )}
          <div style={{
            width: 22, height: 22, borderRadius: "50%", zIndex: 1, position: "relative",
            border: `1px solid ${step.state === "done" ? SUCCESS : step.state === "active" ? ACCENT : step.state === "error" ? ERROR : BORDER}`,
            background: step.state === "done" ? SUCCESS : step.state === "active" ? "rgba(245,197,24,0.12)" : step.state === "error" ? ERROR : BG,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 9, fontWeight: 600,
            color: step.state === "done" ? "#000" : step.state === "active" ? ACCENT : step.state === "error" ? "#fff" : MUTED,
          }}>
            {step.state === "done" ? "✓" : step.state === "error" ? "✕" : i + 1}
          </div>
          <div style={{ fontSize: 8, letterSpacing: "0.08em", textTransform: "uppercase", color: step.state === "done" ? SUCCESS : step.state === "active" ? ACCENT : MUTED, marginTop: 4, textAlign: "center", lineHeight: 1.3 }}>
            {step.label}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── STYLE SETUP MODAL ─────────────────────────────────────────────────────────
function StyleSetup({ onComplete }: { onComplete: (profile: StyleProfile) => void }) {
  const [repName, setRepName] = useState("");
  const [sample, setSample] = useState("");
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
      });
    } catch {
      setError("Something went wrong analyzing your style. Try again.");
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.88)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 32, maxWidth: 500, width: "90%" }}>
        <div style={{ fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: ACCENT, marginBottom: 8 }}>First time setup</div>
        <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>Let's learn how you write</div>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 20, lineHeight: 1.6 }}>
          Paste an email you've sent before — a prospecting email, a follow-up, anything. The AI will read it and write all future drafts in your exact style.
        </div>

        <div style={{ fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: MUTED, marginBottom: 6 }}>Your name</div>
        <input
          value={repName}
          onChange={e => setRepName(e.target.value)}
          placeholder="e.g. Darren"
          style={{ width: "100%", background: BG, border: `1px solid ${BORDER}`, borderRadius: 5, padding: "9px 12px", color: "#e8e8e8", fontFamily: "inherit", fontSize: 13, outline: "none", boxSizing: "border-box", marginBottom: 14 }}
        />

        <div style={{ fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: MUTED, marginBottom: 6 }}>
          Paste an email you've written <span style={{ color: MUTED, fontWeight: 400 }}>(or write a few sentences in your style)</span>
        </div>
        <textarea
          value={sample}
          onChange={e => setSample(e.target.value)}
          placeholder={"Hi [Name],\n\nWanted to reach out about..."}
          style={{ width: "100%", background: BG, border: `1px solid ${BORDER}`, borderRadius: 5, padding: "9px 12px", color: "#e8e8e8", fontFamily: "inherit", fontSize: 12, outline: "none", resize: "vertical", minHeight: 140, boxSizing: "border-box", lineHeight: 1.6 }}
        />

        {error && <div style={{ color: ERROR, fontSize: 11, marginTop: 8 }}>{error}</div>}

        <button
          onClick={analyze}
          disabled={analyzing}
          style={{ width: "100%", marginTop: 16, padding: "12px", background: analyzing ? "#333" : ACCENT, border: "none", borderRadius: 6, fontFamily: "inherit", fontSize: 12, fontWeight: 700, color: analyzing ? MUTED : "#000", cursor: analyzing ? "not-allowed" : "pointer" }}>
          {analyzing ? "Analyzing your style…" : "→ Save My Style & Start"}
        </button>

        <div style={{ marginTop: 12, fontSize: 10, color: MUTED, textAlign: "center" }}>
          Don't have an example? Just write 2-3 sentences the way you'd normally open an email.
        </div>
      </div>
    </div>
  );
}

// ── STYLE VIEWER MODAL ────────────────────────────────────────────────────────
function StyleViewer({ profile, onUpdate, onClose }: { profile: StyleProfile; onUpdate: (p: StyleProfile) => void; onClose: () => void }) {
  const [sample, setSample] = useState(profile.writingSample);
  const [analyzing, setAnalyzing] = useState(false);

  const reanalyze = async () => {
    setAnalyzing(true);
    try {
      const raw = await callClaude([{
        role: "user",
        content: `Analyze this person's writing style from their email sample. Extract: tone (formal/casual/warm/direct), typical length, how they open emails, how they sign off, what they lead with, any distinctive phrases or patterns.

Name: ${profile.repName}
Their writing sample:
---
${sample}
---
${profile.editExamples.length > 0 ? `\nThey have also edited AI drafts. Their edits show:\n${profile.editExamples.slice(-3).join("\n---\n")}` : ""}

Return a concise style guide (3-5 sentences) that can be used to write future emails that sound exactly like them. Be specific about patterns you notice.`
      }]);
      onUpdate({ ...profile, writingSample: sample, extractedStyle: raw });
      onClose();
    } catch {
      setAnalyzing(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.88)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 32, maxWidth: 500, width: "90%" }}>
        <div style={{ fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: ACCENT, marginBottom: 8 }}>Your writing style</div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{profile.repName}'s Style Profile</div>
        <div style={{ fontSize: 11, color: INFO, lineHeight: 1.6, marginBottom: 16, padding: "10px 12px", background: "rgba(96,165,250,0.08)", borderRadius: 6, border: `1px solid rgba(96,165,250,0.2)` }}>
          {profile.extractedStyle}
        </div>
        {profile.editExamples.length > 0 && (
          <div style={{ fontSize: 10, color: MUTED, marginBottom: 14 }}>
            ✓ Learned from {profile.editExamples.length} of your edits
          </div>
        )}
        <div style={{ fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: MUTED, marginBottom: 6 }}>Update writing sample</div>
        <textarea
          value={sample}
          onChange={e => setSample(e.target.value)}
          style={{ width: "100%", background: BG, border: `1px solid ${BORDER}`, borderRadius: 5, padding: "9px 12px", color: "#e8e8e8", fontFamily: "inherit", fontSize: 12, outline: "none", resize: "vertical", minHeight: 100, boxSizing: "border-box", lineHeight: 1.6 }}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "10px", background: "transparent", border: `1px solid ${BORDER}`, borderRadius: 6, fontFamily: "inherit", fontSize: 11, color: MUTED, cursor: "pointer" }}>
            Close
          </button>
          <button onClick={reanalyze} disabled={analyzing} style={{ flex: 2, padding: "10px", background: analyzing ? "#333" : ACCENT, border: "none", borderRadius: 6, fontFamily: "inherit", fontSize: 11, fontWeight: 700, color: analyzing ? MUTED : "#000", cursor: analyzing ? "not-allowed" : "pointer" }}>
            {analyzing ? "Updating…" : "→ Update My Style"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function EngineAgent() {
  const [orgName, setOrgName] = useState("");
  const [orgType, setOrgType] = useState("");
  const [orgContext, setOrgContext] = useState("");
  const [batchMode, setBatchMode] = useState(false);
  const [tab, setTab] = useState("contacts");
  const [running, setRunning] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [sent, setSent] = useState<SentItem[]>([]);
  const [logs, setLogs] = useState<{ msg: string; cls: string }[]>([]);
  const [status, setStatus] = useState({ msg: "Enter an org name and run the workflow", cls: "" });
  const [styleProfile, setStyleProfile] = useState<StyleProfile | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [showStyleViewer, setShowStyleViewer] = useState(false);
  const [editingDraft, setEditingDraft] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [expandedResearch, setExpandedResearch] = useState<number | null>(null);
  const [stepStates, setStepStates] = useState<StepState[]>([
    { label: "Find\nContacts", state: "" },
    { label: "Enrich\nEmails", state: "" },
    { label: "Research\nEach", state: "" },
    { label: "Draft\nEmails", state: "" },
    { label: "Review\n& Send", state: "" },
  ]);

  // Load saved style profile from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STYLE_KEY);
      if (saved) setStyleProfile(JSON.parse(saved));
    } catch { /* ignore */ }
  }, []);

  const saveStyleProfile = (profile: StyleProfile) => {
    setStyleProfile(profile);
    try { localStorage.setItem(STYLE_KEY, JSON.stringify(profile)); } catch { /* ignore */ }
  };

  const addLog = useCallback((msg: string, cls = "") => setLogs(prev => [...prev, { msg, cls }]), []);
  const setStep = useCallback((idx: number, state: string) =>
    setStepStates(prev => prev.map((s, i) => i === idx ? { ...s, state } : s)), []);

  const resetAll = () => {
    setContacts([]); setDrafts([]); setLogs([]);
    setStepStates(prev => prev.map(s => ({ ...s, state: "" })));
    setStatus({ msg: "Starting workflow…", cls: "" });
    setEditingDraft(null);
  };

  const handleRunClick = () => {
    if (!styleProfile) { setShowSetup(true); return; }
    runWorkflow();
  };

  const handleStyleComplete = (profile: StyleProfile) => {
    saveStyleProfile(profile);
    setShowSetup(false);
    runWorkflow(profile);
  };

  // Save an edited draft as a style example so Claude learns from it
  const saveEditAsStyle = (originalBody: string, editedBody: string) => {
    if (!styleProfile) return;
    const example = `Original draft:\n${originalBody}\n\nHow ${styleProfile.repName} rewrote it:\n${editedBody}`;
    const updated: StyleProfile = {
      ...styleProfile,
      editExamples: [...styleProfile.editExamples, example].slice(-5), // keep last 5
    };
    saveStyleProfile(updated);
  };

  const runWorkflow = async (profile?: StyleProfile) => {
    const activeProfile = profile || styleProfile;
    if (!orgName.trim()) { alert("Enter an org name."); return; }
    if (running) return;
    setRunning(true);
    resetAll();

    if (batchMode) {
      try {
        setStep(0, "active");
        setStatus({ msg: `Finding 10 orgs similar to ${orgName}…`, cls: "" });
        addLog(`Discovering orgs similar to ${orgName}…`, "info");

        const orgsRaw = await callClaude([{ role: "user", content: `Find 10 real membership organizations similar to "${orgName}" that would be good Engine hotel partnership targets. Engine works with orgs that have repeat member engagement, events, and travel volume.
Return ONLY valid JSON: {"orgs":[{"name":"Full Org Name","type":"e.g. Professional Association"}]}` }]);
        const orgsJson = parseJSON(orgsRaw);
        const orgList: { name: string; type: string }[] = orgsJson?.orgs?.slice(0, 10) || [];
        if (!orgList.length) throw new Error("Could not find similar organizations");
        addLog(`Found ${orgList.length} target orgs`, "ok");
        setStep(0, "done");

        const allContacts: Contact[] = [];
        const allDrafts: Draft[] = [];

        for (let oi = 0; oi < orgList.length; oi++) {
          const org = orgList[oi];
          setStatus({ msg: `${oi + 1}/${orgList.length}: Processing ${org.name}…`, cls: "" });
          addLog(`Processing ${org.name}…`, "info");

          // Contacts
          let orgContacts: Contact[] = [];
          try {
            const ziRaw = await lookupZoomInfo(org.name, org.type, "");
            orgContacts = extractContactsFromText(ziRaw, org.name);
          } catch { /* fall through */ }
          if (!orgContacts.length) {
            const genRaw = await callClaude([{ role: "user", content: `Generate 3 realistic decision-maker contacts for "${org.name}" (${org.type}). Return ONLY valid JSON: {"contacts":[{"name":"Full Name","title":"Title","company":"${org.name}","email":"email@domain.org"}]}` }]);
            const gp = parseJSON(genRaw);
            for (const t of [gp?.contacts, gp?.results]) {
              if (Array.isArray(t) && t.length) { orgContacts = t; break; }
            }
          }
          if (!orgContacts.length) orgContacts = fallbackContacts(org.name);
          orgContacts = orgContacts.slice(0, 3).map((c: Partial<Contact>) => ({
            name: c?.name || "Unknown", title: c?.title || "Director",
            company: c?.company || org.name,
            email: c?.email || (String(c?.name || "contact").split(" ")[0].toLowerCase() + "@" + org.name.toLowerCase().replace(/[^a-z0-9]/g, "") + ".org"),
            source: c?.source || "Generated",
          }));
          allContacts.push(...orgContacts);
          setContacts([...allContacts]);

          // Research
          let orgResearch = "";
          try {
            const webRes = await fetch("/api/research", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orgName: org.name, orgType: org.type, orgContext: "", contactName: "", contactTitle: "" }) });
            if (webRes.ok) orgResearch = (await webRes.json())?.text || "";
            if (!orgResearch.trim()) orgResearch = await callClaude([{ role: "user", content: `Research ${org.name} (${org.type}) for an Engine hotel partnership. What events do they run, how large is their membership, do members travel, and what's the best partnership angle? 4-5 sentences, factual and specific.` }]);
          } catch { /* skip */ }

          // Emails
          const styleContext = activeProfile ? `You are ghostwriting for ${activeProfile.repName} at Engine. Match their exact voice from this sample:\n---\n${activeProfile.writingSample}\n---\nStyle: ${activeProfile.extractedStyle}` : `You are writing outreach for a Engine partnerships rep.`;

          for (let ci = 0; ci < orgContacts.length; ci++) {
            const contact = orgContacts[ci];
            const alreadyContacted = orgContacts.slice(0, ci);
            const crossNote = alreadyContacted.length > 0 ? `CROSS-REFERENCE: You also contacted ${alreadyContacted.map(c => `${c.name} (${c.title})`).join(" and ")} at ${org.name} today. Mention this naturally.` : "";

            let draftRaw = "";
            try {
              draftRaw = await callClaude([{ role: "user", content: `${styleContext}\n\nWrite a partnership outreach email to ${contact.name}, ${contact.title} at ${org.name} (${org.type}).\n\nENGINE: Hotel booking platform. Say "Engine" never "Engine.com". Hotels only.\nVALUE: 1) Preferred hotel rates for org events 2) Member hotel benefit + referral revenue for the org.\nPARTNERSHIP FIT: Orgs with repeat member engagement, events, travel volume. Engine = value multiplier, not just a referral fee.\n${orgResearch ? `RESEARCH: ${orgResearch}` : ""}\n${crossNote}\nROLE: ${contact.title} — angle the pitch to what matters most to someone in this role.\nRULES: No em dashes, no "Engine.com", no generic openers. Vary structure. Short ask at end.\n\nFormat:\nSUBJECT: [subject]\n\n[body]` }]);
            } catch (e) { addLog(`Draft failed for ${contact.name}: ${(e as Error).message}`, "err"); }

            const dp = parseDraft(draftRaw);
            const firstName = contact.name.split(" ")[0];
            const emailBody = dp?.body || `Hi ${firstName},\n\nI'm with Engine, a hotel booking platform for ${org.type.toLowerCase()}s.\n\nOpen to 15 minutes?\n\nBest,\n${activeProfile?.repName || ""}`;
            const orgProper = org.name.split(" ").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
            let subject = stripEmDashes(dp?.subject || "");
            try {
              const sr = await callClaude([{ role: "user", content: `Write a 4-6 word subject line for this cold outreach email to ${contact.name} at ${orgProper}. No em dashes, no exclamation marks, no "partnership" or "opportunity". Just reply with the subject line.\n\n${emailBody}` }]);
              const cleaned = stripEmDashes(sr.trim().replace(/^["']|["']$/g, ""));
              if (cleaned) subject = cleaned;
            } catch { /* keep existing */ }
            if (!subject.trim()) subject = `${orgProper} + Engine`;

            allDrafts.push({ to: contact.name, email: contact.email, subject, body: emailBody, sentAt: null, research: orgResearch });
            setDrafts([...allDrafts]);
          }
          addLog(`✓ ${org.name} complete`, "ok");
        }

        setStep(1, "done"); setStep(2, "done"); setStep(3, "done"); setStep(4, "done");
        setStatus({ msg: `✓ ${allDrafts.length} drafts ready across ${orgList.length} orgs`, cls: "success" });
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
        const genRaw = await callClaude([{
          role: "user",
          content: `Generate 3 realistic decision-maker contacts for "${orgName}" (${orgType}). ${orgContext ? "Context: " + orgContext : ""}
Return ONLY valid JSON: {"contacts":[{"name":"Full Name","title":"Title","company":"${orgName}","email":"email@domain.org"}]}`
        }]);
        const gp = parseJSON(genRaw);
        if (gp) {
          const tries = [gp?.contacts, gp?.data?.contacts, gp?.results];
          for (const t of tries) {
            if (Array.isArray(t) && t.length > 0) { finalContacts = t; break; }
          }
        }
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
${activeProfile.editExamples.slice(-3).join("\n---\n")}` : ""}

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
SUBJECT: [subject line]

[email body]`
          }]);
        } catch (draftErr) {
          addLog(`Draft failed for ${contact.name}: ${(draftErr as Error).message}`, "err");
        }

        const dp = parseDraft(draftRaw);
        const firstName = contact.name.split(" ")[0];
        const emailBody = dp?.body || `Hi ${firstName},\n\nI'm with Engine, a hotel booking platform for ${orgType.toLowerCase()}s.\n\nOpen to 15 minutes to explore the fit?\n\nBest,\n${activeProfile?.repName || ""}`;

        // Generate subject line in a dedicated call so it gets full attention
        const orgProper = contact.company.split(" ").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
        let subject = stripEmDashes(dp?.subject || "");
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
        // Final fallback if subject is still empty
        if (!subject.trim()) subject = `${orgProper} + Engine`;

        newDrafts.push({
          to: contact.name,
          email: contact.email,
          subject,
          body: emailBody,
          sentAt: null,
          research,
        });
        addLog("Draft ready for " + contact.name, "ok");
      }

      setDrafts(newDrafts);
      setStep(3, "done");
      setStep(4, "done");
      setStatus({ msg: "✓ Drafts ready — review and send", cls: "success" });
      addLog("Workflow complete", "ok");
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
    const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(d.email)}&su=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(body)}`;
    window.open(gmailUrl, "_blank");
    if (markSent) {
      const now = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      setDrafts(prev => prev.map((dr, idx) => idx === i ? { ...dr, sentAt: now } : dr));
      setSent(prev => [...prev, { to: d.to, email: d.email, subject: d.subject, sentAt: now }]);
      addLog("Opened Gmail for " + d.to, "ok");
    }
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

  return (
    <div style={{ fontFamily: "'IBM Plex Sans', monospace", background: BG, color: "#e8e8e8", minHeight: "100vh", display: "flex", flexDirection: "column" }}>

      {showSetup && <StyleSetup onComplete={handleStyleComplete} />}
      {showStyleViewer && styleProfile && (
        <StyleViewer
          profile={styleProfile}
          onUpdate={p => { saveStyleProfile(p); }}
          onClose={() => setShowStyleViewer(false)}
        />
      )}

      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 28px", borderBottom: `1px solid ${BORDER}`, background: SURFACE }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, background: ACCENT, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 15, color: "#000" }}>E</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>Engine Agent</div>
            <div style={{ fontSize: 9, color: MUTED, letterSpacing: "0.14em", textTransform: "uppercase", marginTop: 2 }}>Partnership Prospecting AI</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {styleProfile && (
            <button onClick={() => setShowStyleViewer(true)} style={{ background: "none", border: `1px solid ${BORDER}`, borderRadius: 4, padding: "4px 10px", color: MUTED, fontSize: 9, cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.1em", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 5 }}>
              ✎ {styleProfile.repName}'s Style
              {styleProfile.editExamples.length > 0 && <span style={{ background: ACCENT, color: "#000", borderRadius: 3, padding: "1px 4px", fontSize: 8, fontWeight: 700 }}>{styleProfile.editExamples.length}</span>}
            </button>
          )}
          <nav style={{ display: "flex", gap: 24 }}>
            {["contacts", "drafts", "sent"].map(t => (
              <button key={t} onClick={() => setTab(t)} style={{ background: "none", border: "none", cursor: "pointer", color: tab === t ? ACCENT : MUTED, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6, fontFamily: "inherit" }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: (t === "contacts" ? contacts.length > 0 : t === "drafts" ? drafts.length > 0 : sent.length > 0) ? ACCENT : BORDER, display: "inline-block" }} />
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <div style={{ display: "flex", flex: 1 }}>
        <div style={{ width: 360, minWidth: 320, borderRight: `1px solid ${BORDER}`, padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 18 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div style={{ fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: MUTED }}>Target Organization</div>
              <div style={{ display: "flex", background: BG, border: `1px solid ${BORDER}`, borderRadius: 5, overflow: "hidden" }}>
                {[["Single", false], ["Batch (10 orgs)", true]].map(([label, val]) => (
                  <button key={String(label)} onClick={() => setBatchMode(val as boolean)}
                    style={{ padding: "4px 10px", fontSize: 9, fontFamily: "inherit", border: "none", cursor: "pointer", letterSpacing: "0.08em", textTransform: "uppercase", background: batchMode === val ? ACCENT : "transparent", color: batchMode === val ? "#000" : MUTED, fontWeight: batchMode === val ? 700 : 400 }}>
                    {label as string}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: MUTED, marginBottom: 6 }}>{batchMode ? "Starting Point" : "Org Name"}</div>
            <input style={{ width: "100%", background: BG, border: `1px solid ${BORDER}`, borderRadius: 5, padding: "9px 12px", color: "#e8e8e8", fontFamily: "inherit", fontSize: 13, outline: "none", boxSizing: "border-box" }}
              value={orgName} onChange={e => setOrgName(e.target.value)} placeholder={batchMode ? "e.g. DECA — we'll find 10 similar orgs" : "e.g. BPA, DECA, SkillsUSA"} />
            {!batchMode && (<>
              <div style={{ fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: MUTED, marginBottom: 6, marginTop: 14 }}>Org Type <span style={{ color: BORDER }}>(optional)</span></div>
              <input style={{ width: "100%", background: BG, border: `1px solid ${BORDER}`, borderRadius: 5, padding: "9px 12px", color: "#e8e8e8", fontFamily: "inherit", fontSize: 12, outline: "none", boxSizing: "border-box" }}
                value={orgType} onChange={e => setOrgType(e.target.value)} placeholder="e.g. Professional Association, Student Org…" />
            </>)}
            <div style={{ fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: MUTED, marginBottom: 6, marginTop: 14 }}>Context <span style={{ color: BORDER }}>(optional)</span></div>
            <textarea style={{ width: "100%", background: BG, border: `1px solid ${BORDER}`, borderRadius: 5, padding: "9px 12px", color: "#e8e8e8", fontFamily: "inherit", fontSize: 12, outline: "none", resize: "vertical", minHeight: 60, boxSizing: "border-box" }}
              value={orgContext} onChange={e => setOrgContext(e.target.value)} placeholder={batchMode ? "e.g. Focus on orgs with large annual conferences…" : "e.g. Runs national conferences with 10k+ attendees..."} />
            <button onClick={handleRunClick} disabled={running || !orgName}
              style={{ width: "100%", padding: "13px", background: running || !orgName ? "#333" : ACCENT, border: "none", borderRadius: 6, fontFamily: "inherit", fontSize: 12, fontWeight: 700, color: running || !orgName ? MUTED : "#000", cursor: running || !orgName ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 14 }}>
              {running ? "Running…" : batchMode ? "→ Find 10 Orgs & Draft Emails" : styleProfile ? "→ Run Full Workflow" : "→ Set Up My Style & Run"}
            </button>
          </div>

          <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 18 }}>
            <Steps steps={stepStates} />
            <div style={{ fontFamily: "monospace", fontSize: 11, color: status.cls === "error" ? ERROR : status.cls === "success" ? SUCCESS : MUTED, textAlign: "center", minHeight: 18, marginTop: 8 }}>{status.msg}</div>
            {logs.length > 0 && (
              <div style={{ marginTop: 10, borderTop: `1px solid ${BORDER}`, paddingTop: 10 }}>
                {logs.map((l, i) => <div key={i} style={{ fontFamily: "monospace", fontSize: 10, color: l.cls === "ok" ? SUCCESS : l.cls === "err" ? ERROR : l.cls === "info" ? INFO : MUTED, padding: "1px 0" }}>› {l.msg}</div>)}
              </div>
            )}
          </div>
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", borderBottom: `1px solid ${BORDER}`, padding: "0 20px", background: SURFACE }}>
            {["contacts", "drafts", "sent"].map(t => (
              <button key={t} onClick={() => setTab(t)} style={{ padding: "13px 16px", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: tab === t ? ACCENT : MUTED, border: "none", background: "none", cursor: "pointer", borderBottom: `2px solid ${tab === t ? ACCENT : "transparent"}`, marginBottom: -1, fontFamily: "inherit" }}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
                {t === "contacts" && contacts.length > 0 && ` (${contacts.length})`}
                {t === "drafts" && drafts.length > 0 && ` (${drafts.length})`}
                {t === "sent" && sent.length > 0 && ` (${sent.length})`}
              </button>
            ))}
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            {tab === "contacts" && (contacts.length === 0
              ? <div style={{ padding: "60px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}><div style={{ fontSize: 30, opacity: 0.2 }}>👤</div><div style={{ fontSize: 12, color: MUTED }}>Run the workflow to find contacts</div></div>
              : contacts.map((c, i) => (
                <div key={i} style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 7, padding: 14, display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 10 }}>
                  <div style={{ width: 36, height: 36, borderRadius: "50%", background: "rgba(245,197,24,0.1)", border: `1px solid ${ACCENT}`, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 600, fontSize: 13, color: ACCENT, flexShrink: 0 }}>{c.name.charAt(0)}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{c.name}</div>
                    <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{c.title} · {c.company}</div>
                    <div style={{ fontFamily: "monospace", fontSize: 10, color: INFO, marginTop: 5 }}>{c.email}</div>
                  </div>
                  <div style={{ fontSize: 9, padding: "3px 7px", borderRadius: 3, background: c.source === "ZoomInfo" ? "rgba(96,165,250,0.1)" : "rgba(245,197,24,0.1)", color: c.source === "ZoomInfo" ? INFO : ACCENT, letterSpacing: "0.08em", textTransform: "uppercase" }}>{c.source}</div>
                </div>
              ))
            )}

            {tab === "drafts" && (drafts.length === 0
              ? <div style={{ padding: "60px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}><div style={{ fontSize: 30, opacity: 0.2 }}>✉</div><div style={{ fontSize: 12, color: MUTED }}>Run the workflow to generate drafts</div></div>
              : drafts.map((d, i) => (
                <div key={i} style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 7, padding: 16, marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 11, color: MUTED }}>To: <span style={{ color: "#e8e8e8", fontWeight: 500 }}>{d.to}</span> <span style={{ color: MUTED }}>{"<"}{d.email}{">"}</span></div>
                      <div style={{ fontSize: 13, fontWeight: 600, marginTop: 3 }}>{d.subject}</div>
                    </div>
                    {d.sentAt && <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 3, background: "rgba(76,175,80,0.15)", color: SUCCESS, letterSpacing: "0.08em" }}>SENT {d.sentAt}</span>}
                    {d.edited && !d.sentAt && <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 3, background: "rgba(245,197,24,0.1)", color: ACCENT, letterSpacing: "0.08em" }}>EDITED</span>}
                  </div>

                  {d.research && (
                    <div style={{ marginBottom: 10 }}>
                      <button
                        onClick={() => setExpandedResearch(expandedResearch === i ? null : i)}
                        style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: expandedResearch === i ? ACCENT : MUTED, padding: 0, display: "flex", alignItems: "center", gap: 4 }}>
                        {expandedResearch === i ? "▾" : "▸"} AI Research Notes
                      </button>
                      {expandedResearch === i && (
                        <div style={{ marginTop: 6, padding: "10px 12px", background: "rgba(245,197,24,0.05)", border: `1px solid rgba(245,197,24,0.15)`, borderRadius: 5, fontSize: 11, color: "#bbb", lineHeight: 1.6 }}>
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
                        style={{ width: "100%", background: BG, border: `1px solid ${ACCENT}`, borderRadius: 5, padding: "10px 12px", color: "#e8e8e8", fontFamily: "inherit", fontSize: 12, outline: "none", resize: "vertical", minHeight: 160, boxSizing: "border-box", lineHeight: 1.65 }}
                      />
                      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                        <button onClick={() => saveEdit(i)}
                          style={{ padding: "7px 14px", background: ACCENT, color: "#000", border: "none", borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                          ✓ Save Edit & Update My Style
                        </button>
                        <button onClick={() => setEditingDraft(null)}
                          style={{ padding: "7px 14px", background: "transparent", color: MUTED, border: `1px solid ${BORDER}`, borderRadius: 4, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>
                          Cancel
                        </button>
                      </div>
                      <div style={{ fontSize: 10, color: MUTED, marginTop: 6 }}>
                        Your edits will be saved to improve future drafts automatically.
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize: 12, color: "#aaa", lineHeight: 1.65, whiteSpace: "pre-wrap" }}>{d.edited || d.body}</div>
                      {!d.sentAt && (
                        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                          <button onClick={() => openInGmail(d, i, true)}
                            style={{ padding: "7px 14px", background: ACCENT, color: "#000", border: "none", borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                            ✉ Open in Gmail
                          </button>
                          <button onClick={() => startEditing(i)}
                            style={{ padding: "7px 14px", background: "transparent", color: MUTED, border: `1px solid ${BORDER}`, borderRadius: 4, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>
                            ✎ Edit Draft
                          </button>
                          <button onClick={() => openInGmail(d, i, false)}
                            style={{ padding: "7px 14px", background: "transparent", color: MUTED, border: `1px solid ${BORDER}`, borderRadius: 4, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>
                            Preview only
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))
            )}

            {tab === "sent" && (sent.length === 0
              ? <div style={{ padding: "60px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}><div style={{ fontSize: 30, opacity: 0.2 }}>📤</div><div style={{ fontSize: 12, color: MUTED }}>No sent emails yet</div></div>
              : sent.map((item, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: `1px solid ${BORDER}` }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{item.to}</div>
                    <div style={{ fontSize: 11, color: MUTED }}>{item.subject}</div>
                  </div>
                  <div style={{ fontFamily: "monospace", fontSize: 11, color: MUTED }}>{item.sentAt}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
