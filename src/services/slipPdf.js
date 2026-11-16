/**
 * Salary slip as a PDF (A4, one page per employee), same content as the Word
 * slip: branded letterhead, employee details, attendance, and the salary
 * breakup (Salary, Add Bonus, Add Week-off Bonus, Less Unpaid Leave, Less
 * Advance, [Less Other Deductions] = Net Payable).
 *
 * Rows come from computeRow() — the same server-side numbers Payroll shows.
 * DejaVu Sans is embedded because the PDF standard fonts have no ₹ glyph.
 */
import PDFDocument from "pdfkit";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const FONT = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf");
const FONT_BOLD = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf");
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const HEADER = path.join(PUBLIC, "letterhead-header.png");
const FOOTER = path.join(PUBLIC, "letterhead-footer.png");

const W = 595.28, H = 841.89;                // A4 in points
const SIDE = 68;                             // 2.4 cm, as in the Word reports
const CONTENT_W = W - SIDE * 2;
const HEADER_H = W * 462 / 1654;             // artwork aspect ratios
const FOOTER_H = W * 244 / 1654;

const money = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");

/** Font size at which `text` fits on one line in `width` (never below 6pt). */
function fitSize(doc, font, text, size, width) {
  doc.font(font).fontSize(size);
  const w = doc.widthOfString(text);
  return w <= width ? size : Math.max(6, Math.floor(size * width / w * 10) / 10);
}
/** One line of text in a box: shrunk to fit (down to 7pt), then cut with "…", so it never wraps or spills. */
function fitText(doc, font, text, x, y, width, size, align) {
  const s = Math.max(7, fitSize(doc, font, text, size, width));
  doc.font(font).fontSize(s);
  let t = text;
  while (t.length > 1 && doc.widthOfString(t) > width) t = t.slice(0, -2) + "…";
  doc.fillColor("#000").text(t, x, y + (size - s) / 2, { width: width + 1, align, lineBreak: false });
}
/** Draw one bordered cell with a single line of text (or a small heading + value). */
function cell(doc, x, y, w, h, text, { bold = false, align = "left", size = 9.5, sub = null } = {}) {
  doc.rect(x, y, w, h).lineWidth(0.6).strokeColor("#000").stroke();
  const t = String(text ?? "");
  if (sub) {
    fitText(doc, "B", sub, x + 3, y + 4, w - 6, 7.5, align);
    fitText(doc, bold ? "B" : "R", t, x + 3, y + 15, w - 6, size, align);
  } else {
    fitText(doc, bold ? "B" : "R", t, x + 6, y + (h - size) / 2 - 1, w - 12, size, align);
  }
}

function slipPage(doc, r, bank, label) {
  doc.image(HEADER, 0, 0, { width: W });
  doc.image(FOOTER, 0, H - FOOTER_H, { width: W });

  let y = HEADER_H + 14;
  doc.font("B").fontSize(16).fillColor("#000").text("SALARY SLIP", SIDE, y, { width: CONTENT_W, align: "center", characterSpacing: 2 });
  y += 21;
  doc.font("B").fontSize(10.5).text(label, SIDE, y, { width: CONTENT_W, align: "center" });
  y += 22;

  // Employee details — two label/value pairs per row
  const lw = CONTENT_W * 0.22, vw = CONTENT_W * 0.28, rh = 20;
  const pair = (l1, v1, l2, v2) => {
    cell(doc, SIDE, y, lw, rh, l1, { bold: true }); cell(doc, SIDE + lw, y, vw, rh, v1 || "—");
    cell(doc, SIDE + lw + vw, y, lw, rh, l2, { bold: true }); cell(doc, SIDE + 2 * lw + vw, y, vw, rh, v2 || "—");
    y += rh;
  };
  pair("Employee ID", r.empCode, "Name", r.name);
  pair("Designation", r.desig, "Location", r.loc);
  pair("Date of Joining", r.joining, "Salary Date", r.salaryDate);
  if (bank && bank.bank_name) {
    cell(doc, SIDE, y, lw, rh, "Bank", { bold: true });
    cell(doc, SIDE + lw, y, CONTENT_W - lw, rh, `${bank.bank_name}${bank.ifsc ? " / " + bank.ifsc : ""}`);
    y += rh;
  }

  // Attendance — one row of six figures
  y += 12;
  doc.font("B").fontSize(10).text("Attendance", SIDE, y); y += 14;
  const woUnused = r.woUnused || 0;
  const att = [["Base Days", r.bd], ["Week Off Taken", r.wo], ["Unused Week Off", woUnused],
    ["Leaves", r.lv], ["Work Days", r.wd], ["Paid Days", r.paidDays]];
  const aw = CONTENT_W / att.length;
  att.forEach(([h, v], i) => cell(doc, SIDE + i * aw, y, aw, 30, v ?? 0, { sub: h, align: "center", size: 10 }));
  y += 30;

  // Salary breakup
  y += 12;
  doc.font("B").fontSize(10).text("Salary Breakup", SIDE, y); y += 14;
  const amtW = CONTENT_W * 0.32, labW = CONTENT_W - amtW, bh = 21;
  const perDay = r.bd ? Math.round((r.salary || 0) / r.bd) : 0;
  const payDays = (r.paidDays != null ? r.paidDays : r.bd) - woUnused;
  const unpaidDays = Math.max(0, r.bd - payDays);
  const cut = (r.salary || 0) - (r.earned || 0);
  const midMonth = r.availDays != null && r.availDays < r.bd;
  const line = (lbl, note, v, sign, bold = false, size = 9.5) => {
    cell(doc, SIDE, y, labW, bh, lbl, { bold, size }); cell(doc, SIDE + labW, y, amtW, bh, sign + money(v), { align: "right", bold, size });
    if (note) {
      doc.font(bold ? "B" : "R").fontSize(size);
      const used = doc.widthOfString(lbl) + 6;
      fitText(doc, "R", note, SIDE + 6 + used, y + (bh - size) / 2, labW - 12 - used, 7.5, "left");
    }
    y += bh;
  };
  line("Monthly Salary", "", r.salary, "");
  line("Add: Bonus", "", r.bonus, "+ ");
  line("Add: Week-off Bonus", woUnused ? `(${woUnused} unused week off × ${money(perDay)}/day)` : "", r.woBonus || 0, "+ ");
  if (cut >= 0) line("Less: Unpaid Leave", unpaidDays ? `(${unpaidDays} day(s)${midMonth ? ", incl. days not employed" : ""} × ${money(perDay)}/day)` : "", cut, "− ");
  else line("Add: Extra Days Worked", "", -cut, "+ ");
  line("Less: Advance Recovery", "", r.rec, "− ");
  if (r.ded) line("Less: Other Deductions", "", r.ded, "− ");
  line("NET PAYABLE", "", r.net, "", true, 12);

  y += 16;
  doc.font("R").fontSize(8).text("This is a system-generated salary slip and does not require a signature.", SIDE, y);
}

/**
 * Write a PDF with one slip per row to `stream`.
 * @param rows     computeRow() results
 * @param banks    Map empId -> { bank_name, ifsc }
 * @param label    e.g. "October 2026"
 */
export function writeSlipsPdf(stream, rows, banks, label) {
  const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: false, info: { Title: `Salary Slips — ${label}`, Author: "Yumm Keralam" } });
  doc.registerFont("R", FONT);
  doc.registerFont("B", FONT_BOLD);
  doc.pipe(stream);
  for (const r of rows) { doc.addPage({ size: "A4", margin: 0 }); slipPage(doc, r, banks.get(r.id), label); }
  doc.end();
}
