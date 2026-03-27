"use client";

import { useState, useCallback } from "react";

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
  tone: string;
  length: string;
  signoff: string;
  focus: string;
  extra: string;
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

async function callClaude(messages: { role: string; content: string }[], mcpServers: unknown[] = []) {
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, mcpServers }),
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

// ── STYLE ONBOARDING MODAL ────────────────────────────────────────────────────
function StyleOnboarding({ onComplete }: { onComplete: (profile: StyleProfile) => void }) {
  const [step, setStep] = useState(0);
  const [profile, setProfile] = useState<StyleProfile>({ tone: "", length: "", signoff: "", focus: "", extra: "" });

  const questions = [
    {
      key: "tone", question: "How would you describe your writing tone?",
      options: ["Casual & friendly", "Professional & polished", "Direct & concise", "Warm & personal"],
    },
    {
      key: "length", question: "How long do you like your outreach emails?",
      options: ["Very short (3-4 sentences)", "Short (5-7 sentences)", "Medium (1-2 paragraphs)", "Detailed (2-3 paragraphs)"],
    },
    {
      key: "signoff", question: "What's your usual email sign-off?",
      options: ["Best, [name]", "Thanks, [name]", "Cheers, [name]", "Talk soon, [name]"],
    },
    {
      key: "focus", question: "What do you lead with in outreach?",
      options: ["Their pain point", "Our solution", "A specific stat or hook", "A mutual connection or context"],
    },
  ];

  const current = questions[step];

  const select = (val: string) => {
    const updated = { ...profile, [current.key]: val };
    setProfile(updated);
    if (step < questions.length - 1) {
      setStep(step + 1);
    } else {
      onComplete(updated);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 32, maxWidth: 440, width: "90%" }}>
        <div style={{ fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: ACCENT, marginBottom: 8 }}>
          Style Setup — {step + 1} of {questions.length}
        </div>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>{current.question}</div>
        <div style={{ fontSize: 11, color: MUTED, marginBottom: 20 }}>This helps us write emails that sound like you.</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {current.options.map(opt => (
            <button key={opt} onClick={() => select(opt)} style={{ padding: "11px 14px", background: BG, border: `1px solid ${BORDER}`, borderRadius: 6, color: "#e8e8e8", fontSize: 12, cursor: "pointer", fontFamily: "inherit", textAlign: "left", transition: "border-color 0.2s" }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = ACCENT)}
              onMouseLeave={e => (e.currentTarget.style.borderColor = BORDER)}>
              {opt}
            </button>
          ))}
        </div>
        <div style={{ marginTop: 16, display: "flex", gap: 4 }}>
          {questions.map((_, i) => (
            <div key={i} style={{ flex: 1, height: 3, borderRadius: 2, background: i <= step ? ACCENT : BORDER }} />
          ))}
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
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [stepStates, setStepStates] = useState<StepState[]>([
    { label: "ZoomInfo\nLookup", state: "" },
    { label: "Pull\nEmails", state: "" },
    { label: "Draft\nEmails", state: "" },
    { label: "Review\n& Send", state: "" },
  ]);

  const addLog = useCallback((msg: string, cls = "") => setLogs(prev => [...prev, { msg, cls }]), []);
  const setStep = useCallback((idx: number, state: string) =>
    setStepStates(prev => prev.map((s, i) => i === idx ? { ...s, state } : s)), []);

  const resetAll = () => {
    setContacts([]); setDrafts([]); setLogs([]);
    setStepStates(prev => prev.map(s => ({ ...s, state: "" })));
    setStatus({ msg: "Starting workflow…", cls: "" });
  };

  const handleRunClick = () => {
    if (!styleProfile) {
      setShowOnboarding(true);
    } else {
      runWorkflow();
    }
  };

  const handleStyleComplete = (profile: StyleProfile) => {
    setStyleProfile(profile);
    setShowOnboarding(false);
    runWorkflow(profile);
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
          addLog("Generated email for " + c.name, "info");
        }
        return c;
      });
      setContacts(enriched);
      setStep(1, "done");
      addLog("Step 2 done — emails ready", "ok");

      // ── STEP 3: Draft Emails ─────────────────────────
      setStep(2, "active");
      setStatus({ msg: "Drafting personalized emails…", cls: "" });
      const newDrafts: Draft[] = [];

      const styleInstructions = activeProfile ? `
Writing style instructions for this rep:
- Tone: ${activeProfile.tone}
- Length preference: ${activeProfile.length}
- Sign-off style: ${activeProfile.signoff}
- Lead with: ${activeProfile.focus}
Match this style closely.` : "";

      for (const contact of enriched) {
        const draftRaw = await callClaude([{
          role: "user",
          content: `You are a business development rep at Engine.com — a B2B travel platform for group travel (conferences, events, student trips).

Write a short outreach email to:
Name: ${contact.name}
Title: ${contact.title}
Org: ${contact.company} (${orgType})
${orgContext ? "Context: " + orgContext : ""}
${styleInstructions}

Rules:
- Reference their likely group travel / event needs
- Pitch Engine.com (group booking, cost savings, dedicated support)
- End with ask for a 15-min call
- Do NOT make it sound like a template

Return ONLY valid JSON:
{"subject":"subject line","body":"email body"}`
        }]);

        const dp = parseJSON(draftRaw);
        newDrafts.push({
          to: contact.name, email: contact.email,
          subject: dp?.subject || `Partnership Opportunity — Engine.com × ${orgName}`,
          body: dp?.body || `Hi ${contact.name.split(" ")[0]},\n\nWanted to reach out about Engine.com and ${contact.company}. We simplify group travel for events — saving time and money.\n\nWould love a quick 15-min call.\n\n${activeProfile?.signoff || "Best,\nDarren"}`,
          sentAt: null,
        });
        addLog("Draft ready for " + contact.name, "ok");
      }

      setDrafts(newDrafts);
      setStep(2, "done");
      setStep(3, "done");
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
    const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(d.email)}&su=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`;
    window.open(gmailUrl, "_blank");
    if (markSent) {
      const now = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      setDrafts(prev => prev.map((dr, idx) => idx === i ? { ...dr, sentAt: now } : dr));
      setSent(prev => [...prev, { to: d.to, email: d.email, subject: d.subject, sentAt: now }]);
      addLog("Opened Gmail for " + d.to, "ok");
    }
  };

  return (
    <div style={{ fontFamily: "'IBM Plex Sans', monospace", background: BG, color: "#e8e8e8", minHeight: "100vh", display: "flex", flexDirection: "column" }}>

      {showOnboarding && <StyleOnboarding onComplete={handleStyleComplete} />}

      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 28px", borderBottom: `1px solid ${BORDER}`, background: SURFACE }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, background: ACCENT, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 15, color: "#000" }}>E</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>Engine Agent</div>
            <div style={{ fontSize: 9, color: MUTED, letterSpacing: "0.14em", textTransform: "uppercase", marginTop: 2 }}>Partnership Prospecting AI</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          {styleProfile && (
            <button onClick={() => setShowOnboarding(true)} style={{ background: "none", border: `1px solid ${BORDER}`, borderRadius: 4, padding: "4px 10px", color: MUTED, fontSize: 9, cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.1em", textTransform: "uppercase" }}>
              ✎ My Style
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
              {running ? "Running…" : styleProfile ? "→ Run Full Workflow" : "→ Set My Style & Run"}
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
                  </div>
                  <div style={{ fontSize: 12, color: "#aaa", lineHeight: 1.65, whiteSpace: "pre-wrap" }}>{d.body}</div>
                  {!d.sentAt && (
                    <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                      <button onClick={() => openInGmail(d, i, true)}
                        style={{ padding: "7px 14px", background: ACCENT, color: "#000", border: "none", borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}>
                        ✉ Open in Gmail
                      </button>
                      <button onClick={() => openInGmail(d, i, false)}
                        style={{ padding: "7px 14px", background: "transparent", color: MUTED, border: `1px solid ${BORDER}`, borderRadius: 4, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>
                        Preview only
                      </button>
                    </div>
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
