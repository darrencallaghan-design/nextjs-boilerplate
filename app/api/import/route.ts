import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";

function formatDate(val: unknown): string | null {
  if (!val) return null;
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null;
    return val.toISOString().split("T")[0];
  }
  if (typeof val === "string") {
    const s = val.trim();
    if (!s) return null;
    const parts = s.split("/");
    if (parts.length === 3) {
      const [m, d, y] = parts;
      return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    }
    return s;
  }
  if (typeof val === "number") {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const date = new Date(epoch.getTime() + val * 86400000);
    return date.toISOString().split("T")[0];
  }
  return null;
}

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file") as File;
  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: "array", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(ws, { defval: "" });

  const entries = rows.map((row) => {
    const firstName = String(row["First Name"] || "").trim();
    const lastName = String(row["Last Name"] || "").trim();
    const contactName =
      [firstName, lastName].filter(Boolean).join(" ") ||
      String(row["Contact"] || row["contact_name"] || "").trim();

    const dateSent = formatDate(row["Date Sent"] || row["date_sent"]);
    const followUpDue = formatDate(
      row["Follow-Up Due"] || row["Follow Up Due"] || row["follow_up_due"]
    );

    return {
      id: crypto.randomUUID(),
      repName: String(row["Rep"] || row["rep_name"] || "").trim(),
      wave: 1,
      smerfCategory: String(
        row["Category"] || row["Org Type"] || row["smerf_category"] || ""
      ).trim(),
      organization: String(
        row["Organization"] || row["Company"] || row["organization"] || ""
      ).trim(),
      contactName,
      title: String(row["Title"] || row["title"] || "").trim(),
      email: String(row["Email"] || row["email"] || "").trim(),
      subjectLine: String(
        row["Subject"] || row["Subject Line"] || row["subject_line"] || ""
      ).trim(),
      dateSent,
      status: dateSent ? "Sent" : "Pending",
      stage: "Prospecting",
      followUpDue,
      followUpSent: false,
      notes: String(row["Notes"] || row["notes"] || "").trim(),
    };
  }).filter((e) => e.contactName || e.organization);

  // Group by org for the generate flow
  const orgMap: Record<
    string,
    {
      name: string;
      type: string;
      contacts: { name: string; title: string; company: string; email: string; source: string }[];
    }
  > = {};

  entries.forEach((e) => {
    if (!e.organization) return;
    if (!orgMap[e.organization]) {
      orgMap[e.organization] = { name: e.organization, type: e.smerfCategory, contacts: [] };
    }
    if (e.contactName) {
      orgMap[e.organization].contacts.push({
        name: e.contactName,
        title: e.title,
        company: e.organization,
        email: e.email,
        source: "Imported",
      });
    }
  });

  return NextResponse.json({
    entries,
    orgs: Object.values(orgMap),
    count: entries.length,
  });
}
