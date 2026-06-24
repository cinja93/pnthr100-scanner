// PNTHR Accounting — PDF renderers (forensic fidelity to NAV's originals).
//
// These reproduce NAV Fund Services' investor-facing statements pixel-faithfully, but
// from OUR data. The single intentional difference is the administrator attribution in
// the footer (NAV -> PNTHR), since we cannot present NAV's name/logo on documents NAV
// did not produce. Everything else — layout, labels, column order, number formatting
// (negatives in parentheses, dash for zero/none), fonts — matches the original.
//
// Renderers are data-driven: they take a plain statement object (the contract the
// accounting engine fills) and return a PDF Buffer.

import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOGO = path.resolve(__dirname, '../client/src/assets/panther-head-sm.png');

// Letter page geometry (points).
const PW = 612, PH = 792;
const LM = 58, RM = 58;           // left / right margins
const CONTENT_R = PW - RM;        // right content edge

// Palette tuned to NAV's statement.
const NAVY = '#1f3a5f';
const INK = '#222222';
const GREY = '#777777';
const SHADE = '#eef0f2';
const RULE = '#222222';
const LINK = '#2b5fa8';

// ── number formatting (matches NAV exactly) ─────────────────────────────────────
function money(v) {
  if (v == null || v === 0) return '-';
  const neg = v < 0;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return neg ? `(${s})` : s;
}
function pct(v) {
  if (v == null) return '-';
  const neg = v < 0;
  const s = (Math.abs(v) * 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return neg ? `(${s}%)` : `${s}%`;
}

// Account Statement formatting: blanks render EMPTY (not a dash), negative dollars in
// parentheses, and NET ROR negatives use a MINUS sign (NAV formats the percent
// differently here than on the Individual statement — preserved exactly).
function acctMoney(v) {
  if (v == null) return '';
  const neg = v < 0;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return neg ? `(${s})` : s;
}
function acctPct(v) {
  if (v == null) return '';
  const neg = v < 0;
  const s = (Math.abs(v) * 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return neg ? `-${s}%` : `${s}%`;
}

// ── Account Statement (fund-level income + change in NAV) ────────────────────────
export function renderAccountStatement(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'letter', margin: 0, bufferPages: true,
      info: { Title: 'Account Statement', Author: data.signatory?.[0] || 'PNTHR Funds, LLC' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const ML = 22, MR = 22, CR = PW - MR;
    doc.rect(0, 0, PW, PH).fill('#ffffff');

    // ── Header band ──
    const h = data.header;
    doc.rect(0, 0, PW, 72).fill(NAVY);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(15).text(h.fundName, ML, 11);
    doc.font('Helvetica').fontSize(9.5).text(h.statementTitle || 'Account Statement (Unaudited)', ML, 32);
    doc.fontSize(8.5);
    doc.text(`For the Period Ended ${h.periodEnded}`, ML, 48);
    doc.text(`Reporting Currency : ${h.currency || 'USD'}`, ML, 60);
    doc.text(`Start Of Period : ${h.startOfPeriod}`, 340, 48);
    doc.text(`End Of Period  : ${h.endOfPeriod}`, 340, 60);

    // ── Column geometry ──
    const labelX = ML + 2;
    const cR = [330, 416, 502, CR];   // right edges of the 4 value columns
    const colW = 84;
    const rowH = 15;
    let y = 86;

    const drawValues = (values, { bold } = {}) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(INK);
      for (let i = 0; i < 4; i++) {
        const fmt = values.isPercent ? acctPct : acctMoney;
        doc.text(fmt(values[i]), cR[i] - colW, y, { width: colW, align: 'right' });
      }
    };
    const topBorderOverValues = () => {
      doc.moveTo(cR[0] - colW, y - 2).lineTo(cR[3], y - 2).lineWidth(0.5).strokeColor('#999999').stroke();
    };

    // ── Header row: "Statement of Income" + column titles ──
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10).text('Statement of Income', labelX, y);
    doc.fontSize(8.5);
    ['Period to Date', 'Month to Date', 'Quarter to Date', 'Year to Date'].forEach((t, i) => {
      doc.text(t, cR[i] - colW, y + 1, { width: colW, align: 'right' });
    });
    y += rowH;
    doc.moveTo(ML, y - 2).lineTo(CR, y - 2).lineWidth(0.6).strokeColor(NAVY).stroke();

    // ── Income rows ──
    for (const row of data.income) {
      if (row.type === 'subheader') {
        doc.fillColor('#5a4a3a').font('Helvetica-Oblique').fontSize(9).text(row.label, labelX, y);
      } else {
        const bold = row.type === 'total' || row.type === 'net';
        if (row.type === 'subtotal' || row.type === 'total' || row.type === 'net') topBorderOverValues();
        if (row.label) { doc.fillColor(INK).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).text(row.label, labelX + (row.indent ? 6 : 0), y); }
        if (row.values) { const v = row.values; v.isPercent = row.isPercent; drawValues(v, { bold }); }
      }
      y += rowH;
    }

    // ── Statement of Changes in NAV ──
    y += 4;
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10).text('Statement of Changes in Net Asset Value', labelX, y);
    y += rowH + 2;
    for (const row of data.navChanges) {
      const bold = row.type === 'total';
      if (row.type === 'total') topBorderOverValues();
      doc.fillColor(INK).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).text(row.label, labelX, y);
      if (row.values) { const v = row.values; v.isPercent = row.isPercent; drawValues(v, { bold }); }
      y += rowH;
    }

    // ── Certification + signatory ──
    y += 12;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.5)
      .text(data.certification, ML, y, { width: CR - ML, align: 'center' });
    y += 24;
    doc.moveTo(ML, y).lineTo(CR, y).lineWidth(0.5).strokeColor('#cccccc').stroke();
    y += 8;
    for (const line of (data.signatory || [])) {
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.5).text(line, ML, y, { width: CR - ML, align: 'center' });
      y += 13;
    }

    // ── Generated-on stamp ──
    doc.fillColor(LINK).font('Helvetica-Bold').fontSize(8.5).text(data.generatedOn, ML, PH - 60);

    doc.end();
  });
}

// ── Individual Account Statement ────────────────────────────────────────────────
export function renderIndividualAccountStatement(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'letter', margin: 0, bufferPages: true,
      info: { Title: 'Individual Account Statement', Author: data.producer?.name || 'PNTHR Funds, LLC' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // White page.
    doc.rect(0, 0, PW, PH).fill('#ffffff');

    // ── Title (top right) ──
    doc.fillColor(NAVY).font('Helvetica').fontSize(21)
      .text('Individual Account Statement', LM, 40, { width: CONTENT_R - LM, align: 'right' });
    doc.fillColor(GREY).font('Helvetica').fontSize(8).text('U N A U D I T E D', LM, 66, { width: CONTENT_R - LM, align: 'right', characterSpacing: 1 });
    doc.moveTo(LM, 80).lineTo(CONTENT_R, 80).lineWidth(1).strokeColor(RULE).stroke();

    // ── Logo + fund block ──
    const logoPath = data.logoPath || DEFAULT_LOGO;
    if (fs.existsSync(logoPath)) {
      try { doc.image(logoPath, LM + 4, 96, { width: 78, height: 78 }); } catch { /* ignore bad image */ }
    }
    const fx = LM + 100;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text(data.fund.name, fx, 104, { width: 280 });
    doc.font('Helvetica').fontSize(9.5).fillColor(INK);
    let ay = 122;
    for (const line of (data.fund.address || [])) { doc.text(line, fx, ay, { width: 280 }); ay += 13; }

    // ── INVESTOR NO. box (top right) ──
    const boxW = 110, boxX = CONTENT_R - boxW, boxY = 100;
    doc.rect(boxX, boxY, boxW, 20).fill(NAVY);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9).text('INVESTOR NO.', boxX, boxY + 6, { width: boxW, align: 'center', characterSpacing: 0.5 });
    doc.rect(boxX, boxY + 20, boxW, 26).lineWidth(1).strokeColor(NAVY).stroke();
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(15).text(String(data.investor.no), boxX, boxY + 26, { width: boxW, align: 'center' });

    // ── Investor address block ──
    let iy = 232;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10);
    doc.text(data.investor.name, fx, iy, { width: 300 }); iy += 14;
    for (const line of (data.investor.address || [])) { doc.text(line, fx, iy, { width: 300 }); iy += 14; }

    // ── Class ──
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK)
      .text(`Class : ${data.investor.class}`, fx, 300);

    // ── Period line ──
    doc.font('Helvetica').fontSize(10.5).fillColor(INK)
      .text('Investor Statement for the Period Ended :', LM, 344, { continued: true })
      .font('Helvetica-Bold').text(`    ${data.periodEnded}`);

    // ── Section header bar ──
    const barY = 384;
    doc.rect(LM, barY, CONTENT_R - LM, 22).fill(NAVY);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10.5)
      .text('CAPITAL ACCOUNT SUMMARY', LM + 8, barY + 6, { characterSpacing: 0.3 });

    // ── Table ──
    const col1R = LM + 372;   // QTD right edge
    const col2R = CONTENT_R;  // YTD right edge
    const colW = 95;
    let ty = barY + 30;

    // column headers
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9.5);
    doc.text('QTD ($)', col1R - colW, ty, { width: colW, align: 'right' });
    doc.text('YTD ($)', col2R - colW, ty, { width: colW, align: 'right' });
    ty += 22;

    const rows = data.capitalAccount.rows;
    const rowH = 30;
    for (const row of rows) {
      if (row.shaded) doc.rect(LM, ty - 7, CONTENT_R - LM, rowH).fill(SHADE);
      doc.fillColor(INK).font(row.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10.5);
      doc.text(row.label, LM + 4, ty, { width: 300 });
      const fmt = row.isPercent ? pct : money;
      doc.text(fmt(row.values[0]), col1R - colW, ty, { width: colW, align: 'right' });
      doc.text(fmt(row.values[1]), col2R - colW, ty, { width: colW, align: 'right' });
      if (row.shaded) {
        doc.moveTo(LM, ty - 7).lineTo(CONTENT_R, ty - 7).lineWidth(0.5).strokeColor('#cccccc').stroke();
        doc.moveTo(LM, ty - 7 + rowH).lineTo(CONTENT_R, ty - 7 + rowH).lineWidth(0.5).strokeColor('#cccccc').stroke();
      }
      ty += rowH;
    }

    // ── Footer: PNTHR producer block (the one approved difference vs NAV) ──
    const p = data.producer || {};
    const fY = PH - 70;
    doc.moveTo(LM, fY - 8).lineTo(CONTENT_R, fY - 8).lineWidth(0.5).strokeColor('#cccccc').stroke();
    if (p.logoPath && fs.existsSync(p.logoPath)) {
      try { doc.image(p.logoPath, LM, fY, { width: 36, height: 36 }); } catch { /* ignore */ }
    }
    const px = p.logoPath ? LM + 46 : LM;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(p.name || 'PNTHR Funds, LLC', px, fY);
    doc.fillColor(GREY).font('Helvetica').fontSize(8.5).text(p.role || 'General Partner & Administrator', px, fY + 14);
    if (p.website) doc.fillColor(LINK).font('Helvetica').fontSize(8.5).text(p.website, px, fY + 26);
    if (p.copyright) doc.fillColor(GREY).fontSize(7.5).text(p.copyright, px, fY + 38);

    doc.end();
  });
}
