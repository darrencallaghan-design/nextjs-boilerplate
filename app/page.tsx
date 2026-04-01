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

const ORG_TYPES = ["Student Organization", "Youth Nonprofit", "Professional Association", "Educational Organization"];

const ROLES: Record<string, string[]> = {
  "Student Organization": ["National Executive Director", "VP of Programs", "Director of Events"],
  "Youth Nonprofit": ["Executive Director", "Programs Director", "Development Director"],
  "Professional Association": ["CEO", "VP of Membership", "Director of Conferences"],
  "Educational Organization": ["President", "Director of Operations", "Events Coordinator"],
};

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

function fallbackContacts(orgName: string, orgType: string): Contact[] {
  const roles = ROLES[orgType] || ROLES["Professional Association"];
  const names = ["Sarah Mitchell", "James Thornton", "Ana Rivera"];
  const domain = orgName.toLowerCase().replace(/[^a-z0-9]/g, "") + ".org";
  return names.map((name, i) => ({
    name, title: roles[i] || "Director", company: orgName,
    email: name.split(" ")[0].toLowerCase() + "@" + domain, source: "Fallback",
  }));
}

function parseJSON(raw: string) {
  try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { return null; }
}

async function callClaude(messages: { role: string; content: string }[]) {
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
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
    if (!orgType) { alert("Select an org type."); return; }
    if (running) return;
    setRunning(true);
    resetAll();

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
        if (!finalContacts.length) finalContacts = fallbackContacts(orgName, orgType);
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

      // ── STEP 3: Research Each Contact ───────────────
      setStep(2, "active");
      setStatus({ msg: `Researching ${orgName} and each contact…`, cls: "" });
      addLog(`Researching ${orgName} to find personalization hooks`, "info");

      const contactResearch: string[] = [];
      for (let ri = 0; ri < enriched.length; ri++) {
        const rc = enriched[ri];
        addLog(`Searching web for ${rc.name} at ${orgName}…`, "info");
        try {
          // Try live web search first
          const webRes = await fetch("/api/research", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              orgName, orgType, orgContext,
              contactName: rc.name,
              contactTitle: rc.title,
            }),
          });
          let researchText = "";
          if (webRes.ok) {
            const webData = await webRes.json();
            researchText = webData?.text || "";
          }
          // If web search returned nothing, fall back to knowledge-based research
          if (!researchText.trim()) {
            addLog(`Web search empty — using AI knowledge for ${rc.name}`, "info");
            researchText = await callClaude([{
              role: "user",
              content: `Based on what you know, research ${orgName} (${orgType}) for a sales outreach email to ${rc.name}, ${rc.title}.
${orgContext ? `Context: ${orgContext}` : ""}

Identify: what events/travel programs they run, a specific pain point for a ${rc.title}, and one tailored angle for Engine.com (group travel platform). Be specific. 4-5 sentences. These are notes for the rep only.`,
            }]);
          }
          contactResearch.push(researchText);
          addLog(`✓ Research ready for ${rc.name}`, "ok");
        } catch {
          contactResearch.push("");
          addLog(`Research skipped for ${rc.name}`, "info");
        }
      }
      setStep(2, "done");

      // ── STEP 4: Draft Emails ─────────────────────────
      setStep(3, "active");
      setStatus({ msg: "Drafting personalized emails in your style…", cls: "" });
      const newDrafts: Draft[] = [];

      const styleContext = activeProfile ? `
You are writing on behalf of ${activeProfile.repName}, a business development rep at Engine.com.

${activeProfile.repName}'s writing style (extracted from their own emails):
${activeProfile.extractedStyle}

${activeProfile.editExamples.length > 0 ? `Examples of how ${activeProfile.repName} edits AI drafts (learn from these):
${activeProfile.editExamples.slice(-3).join("\n---\n")}` : ""}

Write the email to sound EXACTLY like ${activeProfile.repName}. Match their tone, length, structure, and sign-off precisely.` : "";

      for (let ci = 0; ci < enriched.length; ci++) {
        const contact = enriched[ci];
        const research = contactResearch[ci] || "";

        // Cross-contact context: note colleagues already contacted at this org
        const alreadyContacted = enriched.slice(0, ci);
        const crossContactNote = alreadyContacted.length > 0
          ? `\nIMPORTANT — Team coordination: Other Engine reps have already reached out to the following people at ${orgName}: ${alreadyContacted.map(c => `${c.name} (${c.title})`).join(", ")}. If it feels natural, briefly acknowledge this coordination — e.g. "I know my colleague also reached out to ${alreadyContacted[0].name}..." — to show Engine is organized and intentional, not spamming.`
          : "";

        const draftRaw = await callClaude([{
          role: "user",
          content: `${styleContext}

Write a personalized cold outreach email for Engine.com to the contact below. Engine.com is a B2B group travel platform — we help organizations manage group bookings for conferences, competitions, national events, and chapter trips. Key benefits: simplified booking, cost savings (typically 15-20% vs. booking direct), dedicated travel support, and finance-ready reporting.

CONTACT:
Name: ${contact.name}
Title: ${contact.title}
Organization: ${contact.company} (${orgType})
${orgContext ? `Context: ${orgContext}` : ""}
${crossContactNote}

${research ? `RESEARCH (real details found about this org — use at least one specific fact from here):
${research}` : `WHAT TO KNOW: This is a ${orgType}. Think about what travel programs they likely run — national conferences, regional competitions, chapter trips — and what a ${contact.title} would care about most (budget control, logistics complexity, vendor coordination, etc.).`}

WHAT A GREAT EMAIL LOOKS LIKE:
❌ Generic (avoid this):
"Hi Sarah, I hope you're doing well. I wanted to reach out about Engine.com. We're a travel platform that helps organizations save money on group travel. Would you have time for a 15-minute call?"

✅ Specific and tailored (aim for this):
"Hi Sarah — coordinating travel for DECA's national conference is no small task, especially when you're moving thousands of students across 50 states. Engine handles exactly that kind of volume for student orgs, giving chapter advisors one booking portal instead of juggling 10 airline sites. Most orgs we work with save 15-20% on group rates. Would it make sense to connect before you finalize travel vendors for this year's event?"

RULES FOR THIS EMAIL:
- Open with something specific to their org or role — never "I hope this finds you well" or "I wanted to reach out"
- Name a real pain point they'd actually feel (logistics complexity, cost overruns, last-minute changes, finance reporting)
- Mention one concrete Engine.com benefit that maps to that pain point
- End with a soft, specific ask — a 15-min call or a simple reply question
- Length: 3 short paragraphs, roughly 150-220 words in the body
- Tone and structure must match the rep's style described above

Return ONLY valid JSON with no extra text:
{"subject":"subject line here","body":"full email body here"}`
        }]);

        const dp = parseJSON(draftRaw);
        newDrafts.push({
          to: contact.name,
          email: contact.email,
          subject: dp?.subject || `Partnership Opportunity — Engine.com × ${orgName}`,
          body: dp?.body || `Hi ${contact.name.split(" ")[0]},\n\nWanted to reach out about Engine.com and ${contact.company}.\n\nBest,\n${activeProfile?.repName || ""}`,
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
            <div style={{ fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: MUTED, marginBottom: 14 }}>Target Organization</div>
            <div style={{ fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: MUTED, marginBottom: 6 }}>Org Name</div>
            <input style={{ width: "100%", background: BG, border: `1px solid ${BORDER}`, borderRadius: 5, padding: "9px 12px", color: "#e8e8e8", fontFamily: "inherit", fontSize: 13, outline: "none", boxSizing: "border-box" }}
              value={orgName} onChange={e => setOrgName(e.target.value)} placeholder="e.g. BPA, DECA, SkillsUSA" />
            <div style={{ fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: MUTED, marginBottom: 6, marginTop: 14 }}>Org Type</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {ORG_TYPES.map(t => (
                <button key={t} onClick={() => setOrgType(t)} style={{ padding: "9px 10px", background: orgType === t ? "rgba(245,197,24,0.1)" : BG, border: `1px solid ${orgType === t ? ACCENT : BORDER}`, borderRadius: 5, color: orgType === t ? ACCENT : MUTED, fontSize: 11, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>{t}</button>
              ))}
            </div>
            <div style={{ fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: MUTED, marginBottom: 6, marginTop: 14 }}>Context (Optional)</div>
            <textarea style={{ width: "100%", background: BG, border: `1px solid ${BORDER}`, borderRadius: 5, padding: "9px 12px", color: "#e8e8e8", fontFamily: "inherit", fontSize: 12, outline: "none", resize: "vertical", minHeight: 72, boxSizing: "border-box" }}
              value={orgContext} onChange={e => setOrgContext(e.target.value)} placeholder="e.g. Runs national conferences with 10k+ attendees..." />
            <button onClick={handleRunClick} disabled={running || !orgName}
              style={{ width: "100%", padding: "13px", background: running || !orgName ? "#333" : ACCENT, border: "none", borderRadius: 6, fontFamily: "inherit", fontSize: 12, fontWeight: 700, color: running || !orgName ? MUTED : "#000", cursor: running || !orgName ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 14 }}>
              {running ? "Running…" : styleProfile ? "→ Run Full Workflow" : "→ Set Up My Style & Run"}
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
