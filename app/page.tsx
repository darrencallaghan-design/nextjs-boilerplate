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
  sending: boolean;
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

function fallbackContacts(orgName: string, orgType: string): Contact[] {
  const roles = ROLES[orgType] || ROLES["Professional Association"];
  const names = ["Sarah Mitchell", "James Thornton", "Ana Rivera"];
  const domain = orgName.toLowerCase().replace(/[^a-z0-9]/g, "") + ".org";
  return names.map((name, i) => ({
    name, title: roles[i] || "Director", company: orgName,
    email: name.split(" ")[0].toLowerCase() + "@" + domain, source: "Fallback",
  }));
}

async function callAPI(
  messages: { role: string; content: string }[],
  mcpServers: unknown[] = [],
  timeoutMs = 30000
) {
  const body: Record<string, unknown> = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    messages,
  };
  if (mcpServers.length > 0) body.mcp_servers = mcpServers;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`API ${res.status}: ${txt.slice(0, 200)}`);
    }
    const data = await res.json();
    // Collect all text and tool result blocks
    const texts = (data?.content || [])
      .filter((b: { type: string }) => b?.type === "text")
      .map((b: { text: string }) => b.text)
      .join("\n");
    const toolResults = (data?.content || [])
      .filter((b: { type: string }) => b?.type === "mcp_tool_result")
      .map((b: { content?: { text: string }[] }) => b?.content?.[0]?.text || "")
      .join("\n");
    return texts || toolResults || "";
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === "AbortError") throw new Error("TIMEOUT");
    throw err;
  }
}

function parseJSON(raw: string) {
  try {
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch {
    return null;
  }
}

// Extract contacts from ZoomInfo MCP response text
function extractContactsFromText(text: string, orgName: string): Contact[] {
  // Try JSON parse first
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

  // Try to parse structured text response from MCP
  const contacts: Contact[] = [];
  const lines = text.split("\n");
  let current: Partial<Contact> = {};

  for (const line of lines) {
    const l = line.trim();
    if (!l) {
      if (current.name) {
        contacts.push({
          name: current.name || "Unknown",
          title: current.title || "Director",
          company: current.company || orgName,
          email: current.email || "",
          source: "ZoomInfo",
        });
        current = {};
      }
      continue;
    }
    if (l.match(/^name[:\s]/i)) current.name = l.replace(/^name[:\s]*/i, "").trim();
    else if (l.match(/^title[:\s]|^role[:\s]/i)) current.title = l.replace(/^(title|role)[:\s]*/i, "").trim();
    else if (l.match(/^email[:\s]/i)) current.email = l.replace(/^email[:\s]*/i, "").trim();
    else if (l.match(/^company[:\s]|^org[:\s]/i)) current.company = l.replace(/^(company|org)[:\s]*/i, "").trim();
  }
  if (current.name) {
    contacts.push({
      name: current.name, title: current.title || "Director",
      company: current.company || orgName, email: current.email || "", source: "ZoomInfo",
    });
  }

  return contacts.slice(0, 3);
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

  const runWorkflow = async () => {
    if (!orgName.trim()) { alert("Enter an org name."); return; }
    if (!orgType) { alert("Select an org type."); return; }
    if (running) return;
    setRunning(true);
    resetAll();

    // ── STEP 1: ZoomInfo Lookup ──────────────────────
      setStep(0, "active");
      setStatus({ msg: "Searching ZoomInfo for real contacts…", cls: "" });
      addLog("Querying ZoomInfo for: " + orgName, "info");

      let finalContacts: Contact[] = [];

      try {
        const ziRes = await fetch("/api/zoominfo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orgName, orgType, orgContext }),
        });
        const ziData = await ziRes.json();
        const ziRaw = ziData?.text || "";

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
