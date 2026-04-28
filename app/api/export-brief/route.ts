import { NextRequest, NextResponse } from "next/server";
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, LevelFormat, HeadingLevel, BorderStyle, WidthType,
  ShadingType, VerticalAlign, Header, Footer, PageNumber,
  ExternalHyperlink,
} from "docx";

// ── Types ─────────────────────────────────────────────────────────────────────
interface PitchBrief {
  companySnapshot: { name: string; industry: string; size: string; locations: string; description: string; website: string };
  partnershipFit: { score: number; tier: "Strong" | "Potential" | "Low"; signals: string[] };
  distributionPower: { networkSize: string; networkType: string; events: string[]; existingPrograms: string[] };
  engineValueProps: { headline: string; bullets: string[] }[];
  pitchAngles: { angle: string; why: string; openingLine: string }[];
  talkingPoints: string[];
  crossbeamSignals: { partnerName: string; overlapType: string }[];
  recentNews: string[];
  engineAngle: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const ORANGE = "FD4B23";
const DARK = "10121A";
const GREY = "616368";
const LIGHT_GREY = "E8E5E0";
const GREEN = "009262";
const BLUE = "1476D8";

const PAGE_W = 12240; // US Letter
const PAGE_H = 15840;
const MARGIN = 1440;  // 1 inch
const CONTENT_W = PAGE_W - MARGIN * 2; // 9360

const border = { style: BorderStyle.SINGLE, size: 1, color: LIGHT_GREY };
const borders = { top: border, bottom: border, left: border, right: border };
const noBorder = { style: BorderStyle.NIL, size: 0, color: "FFFFFF" };
const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };

function label(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 200, after: 60 },
    children: [new TextRun({ text: text.toUpperCase(), size: 18, bold: true, color: GREY, font: "Arial" })],
  });
}

function body(text: string, opts?: { bold?: boolean; color?: string; size?: number }): Paragraph {
  return new Paragraph({
    spacing: { after: 60 },
    children: [new TextRun({ text, size: opts?.size ?? 22, bold: opts?.bold, color: opts?.color ?? DARK, font: "Arial" })],
  });
}

function spacer(pts = 120): Paragraph {
  return new Paragraph({ spacing: { before: pts, after: 0 }, children: [new TextRun("")] });
}

function sectionTitle(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 280, after: 100 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GREY, space: 4 } },
    children: [new TextRun({ text, size: 24, bold: true, color: DARK, font: "Arial" })],
  });
}

function bullet(text: string, color = DARK): Paragraph {
  return new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { after: 40 },
    children: [new TextRun({ text, size: 22, color, font: "Arial" })],
  });
}

function numbered(text: string): Paragraph {
  return new Paragraph({
    numbering: { reference: "numbers", level: 0 },
    spacing: { after: 60 },
    children: [new TextRun({ text, size: 22, color: DARK, font: "Arial" })],
  });
}

// 2-column info row
function infoRow(labelText: string, value: string): TableRow {
  return new TableRow({
    children: [
      new TableCell({
        borders: noBorders,
        width: { size: 2000, type: WidthType.DXA },
        margins: { top: 60, bottom: 60, left: 0, right: 120 },
        children: [new Paragraph({ children: [new TextRun({ text: labelText, size: 20, bold: true, color: GREY, font: "Arial" })] })],
      }),
      new TableCell({
        borders: noBorders,
        width: { size: 7360, type: WidthType.DXA },
        margins: { top: 60, bottom: 60, left: 0, right: 0 },
        children: [new Paragraph({ children: [new TextRun({ text: value || "—", size: 20, color: DARK, font: "Arial" })] })],
      }),
    ],
  });
}

// ── Main builder ──────────────────────────────────────────────────────────────
function buildDoc(brief: PitchBrief, repName: string): Document {
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const tierColor = brief.partnershipFit.tier === "Strong" ? GREEN : brief.partnershipFit.tier === "Potential" ? BLUE : GREY;

  const children: (Paragraph | Table)[] = [];

  // ── Cover block ──────────────────────────────────────────────────────────
  children.push(
    new Paragraph({
      spacing: { before: 0, after: 60 },
      children: [
        new TextRun({ text: "Partner Brief", size: 20, color: GREY, font: "Arial" }),
        new TextRun({ text: "  ·  ", size: 20, color: GREY, font: "Arial" }),
        new TextRun({ text: "Engine", size: 20, bold: true, color: ORANGE, font: "Arial" }),
      ],
    }),
    new Paragraph({
      spacing: { before: 40, after: 80 },
      children: [new TextRun({ text: brief.companySnapshot.name, size: 52, bold: true, color: DARK, font: "Arial" })],
    }),
  );

  // Industry · size · locations row
  const metaParts = [brief.companySnapshot.industry, brief.companySnapshot.size, brief.companySnapshot.locations]
    .filter(Boolean).join("  ·  ");
  if (metaParts) {
    children.push(new Paragraph({
      spacing: { before: 0, after: 60 },
      children: [new TextRun({ text: metaParts, size: 20, color: GREY, font: "Arial" })],
    }));
  }

  if (brief.companySnapshot.website) {
    children.push(new Paragraph({
      spacing: { before: 0, after: 60 },
      children: [new ExternalHyperlink({
        link: brief.companySnapshot.website.startsWith("http") ? brief.companySnapshot.website : `https://${brief.companySnapshot.website}`,
        children: [new TextRun({ text: brief.companySnapshot.website, size: 20, color: BLUE, font: "Arial", underline: {} })],
      })],
    }));
  }

  // Fit score pill (text representation)
  children.push(
    spacer(80),
    new Paragraph({
      spacing: { before: 0, after: 40 },
      children: [
        new TextRun({ text: `${brief.partnershipFit.tier} Partner Fit  `, size: 22, bold: true, color: tierColor, font: "Arial" }),
        new TextRun({ text: `Score: ${brief.partnershipFit.score}/100`, size: 20, color: GREY, font: "Arial" }),
      ],
    }),
    spacer(160),
  );

  // ── Company Snapshot ──────────────────────────────────────────────────────
  if (brief.companySnapshot.description) {
    children.push(
      sectionTitle("About"),
      body(brief.companySnapshot.description),
      spacer(80),
    );
  }

  // ── Company info table ────────────────────────────────────────────────────
  const infoRows: TableRow[] = [];
  if (brief.companySnapshot.industry) infoRows.push(infoRow("Industry", brief.companySnapshot.industry));
  if (brief.companySnapshot.size) infoRows.push(infoRow("Size", brief.companySnapshot.size));
  if (brief.companySnapshot.locations) infoRows.push(infoRow("Locations", brief.companySnapshot.locations));
  if (brief.distributionPower.networkType && brief.distributionPower.networkType !== "Unknown") {
    infoRows.push(infoRow("Network type", brief.distributionPower.networkType));
  }
  if (brief.distributionPower.networkSize && brief.distributionPower.networkSize !== "Unknown") {
    infoRows.push(infoRow("Est. network", brief.distributionPower.networkSize));
  }

  if (infoRows.length) {
    children.push(
      new Table({
        width: { size: CONTENT_W, type: WidthType.DXA },
        columnWidths: [2000, 7360],
        borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder },
        rows: infoRows,
      }),
      spacer(80),
    );
  }

  // ── Partnership Signals ───────────────────────────────────────────────────
  if (brief.partnershipFit.signals.length > 0) {
    children.push(sectionTitle("Partnership Signals"));
    brief.partnershipFit.signals.forEach(s => children.push(bullet(s, DARK)));
    children.push(spacer(80));
  }

  // ── Distribution Power ────────────────────────────────────────────────────
  if (brief.distributionPower.events.length > 0 || brief.distributionPower.existingPrograms.length > 0) {
    children.push(sectionTitle("Distribution Power"));
    if (brief.distributionPower.events.length > 0) {
      children.push(label("Events they run"));
      brief.distributionPower.events.forEach(e => children.push(bullet(e)));
    }
    if (brief.distributionPower.existingPrograms.length > 0) {
      children.push(label("Existing partner programs"));
      brief.distributionPower.existingPrograms.forEach(p => children.push(bullet(p)));
    }
    children.push(spacer(80));
  }

  // ── Crossbeam ─────────────────────────────────────────────────────────────
  if (brief.crossbeamSignals.length > 0) {
    children.push(sectionTitle("Crossbeam — Warm Paths"));
    brief.crossbeamSignals.forEach(s => {
      children.push(new Paragraph({
        spacing: { after: 60 },
        children: [
          new TextRun({ text: s.partnerName, size: 22, bold: true, color: DARK, font: "Arial" }),
          new TextRun({ text: "  —  " + s.overlapType, size: 22, color: GREY, font: "Arial" }),
        ],
      }));
    });
    children.push(spacer(80));
  }

  // ── Engine Value Props ────────────────────────────────────────────────────
  if (brief.engineValueProps.length > 0) {
    children.push(sectionTitle("Engine Value Props — Tailored"));
    brief.engineValueProps.forEach(vp => {
      children.push(
        new Paragraph({
          spacing: { before: 100, after: 40 },
          children: [new TextRun({ text: vp.headline, size: 22, bold: true, color: ORANGE, font: "Arial" })],
        }),
      );
      vp.bullets.forEach(b => children.push(bullet(b)));
    });
    children.push(spacer(80));
  }

  // ── Pitch Angles ──────────────────────────────────────────────────────────
  if (brief.pitchAngles.length > 0) {
    children.push(sectionTitle("Pitch Angles"));
    brief.pitchAngles.forEach((pa, i) => {
      children.push(
        new Paragraph({
          spacing: { before: 100, after: 40 },
          children: [
            ...(i === 0 ? [new TextRun({ text: "★ RECOMMENDED  ", size: 18, bold: true, color: ORANGE, font: "Arial" })] : []),
            new TextRun({ text: pa.angle, size: 22, bold: true, color: DARK, font: "Arial" }),
          ],
        }),
        new Paragraph({
          spacing: { after: 40 },
          children: [new TextRun({ text: pa.why, size: 20, color: GREY, font: "Arial" })],
        }),
      );
      if (pa.openingLine) {
        children.push(new Paragraph({
          spacing: { after: 80 },
          shading: { fill: "FFF4F1", type: ShadingType.CLEAR },
          indent: { left: 360 },
          border: { left: { style: BorderStyle.SINGLE, size: 12, color: ORANGE, space: 6 } },
          children: [
            new TextRun({ text: "Opening line: ", size: 20, bold: true, color: ORANGE, font: "Arial" }),
            new TextRun({ text: `"${pa.openingLine}"`, size: 20, color: DARK, font: "Arial", italics: true }),
          ],
        }));
      }
    });
    children.push(spacer(80));
  }

  // ── Talking Points ────────────────────────────────────────────────────────
  if (brief.talkingPoints.length > 0) {
    children.push(sectionTitle("Key Talking Points"));
    brief.talkingPoints.forEach(tp => children.push(numbered(tp)));
    children.push(spacer(80));
  }

  // ── Recent News ───────────────────────────────────────────────────────────
  if (brief.recentNews.length > 0) {
    children.push(sectionTitle("Recent News & Timing Signals"));
    brief.recentNews.forEach(n => children.push(bullet(n)));
    children.push(spacer(80));
  }

  // ── Engine Angle (summary) ────────────────────────────────────────────────
  if (brief.engineAngle) {
    children.push(
      sectionTitle("Engine Angle"),
      body(brief.engineAngle),
      spacer(80),
    );
  }

  // ── Footer line ───────────────────────────────────────────────────────────
  children.push(
    spacer(200),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `Prepared by ${repName || "Engine BD"}  ·  ${today}  ·  Confidential`, size: 18, color: GREY, font: "Arial" })],
    }),
  );

  return new Document({
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [{
            level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 400, hanging: 200 } } },
          }],
        },
        {
          reference: "numbers",
          levels: [{
            level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 480, hanging: 240 } } },
          }],
        },
      ],
    },
    styles: {
      default: { document: { run: { font: "Arial", size: 22 } } },
    },
    sections: [{
      properties: {
        page: {
          size: { width: PAGE_W, height: PAGE_H },
          margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
        },
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GREY, space: 4 } },
            children: [
              new TextRun({ text: "Engine  ", size: 18, bold: true, color: ORANGE, font: "Arial" }),
              new TextRun({ text: "Partner Brief", size: 18, color: GREY, font: "Arial" }),
            ],
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: "Page ", size: 18, color: GREY, font: "Arial" }),
              new TextRun({ children: [PageNumber.CURRENT], size: 18, color: GREY, font: "Arial" }),
              new TextRun({ text: " of ", size: 18, color: GREY, font: "Arial" }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: GREY, font: "Arial" }),
            ],
          })],
        }),
      },
      children,
    }],
  });
}

// ── Route handler ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const { brief, repName } = await req.json() as { brief: PitchBrief; repName: string };
    if (!brief) return NextResponse.json({ error: "No brief data" }, { status: 400 });

    const doc = buildDoc(brief, repName || "");
    const buffer = await Packer.toBuffer(doc);
    const uint8 = new Uint8Array(buffer);

    const filename = `${(brief.companySnapshot.name || "partner-brief").replace(/[^a-z0-9]/gi, "-").toLowerCase()}-partner-brief.docx`;

    return new NextResponse(uint8, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(uint8.byteLength),
      },
    });
  } catch (err) {
    console.error("Export brief error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
