// Standalone mockup v4 — yellow PNTHR branding, white headers, larger summary row
// Usage: node server/backtest/navMockup.js

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { MongoClient } from 'mongodb';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.resolve(__dirname, '../../NAV_Mockup_v4.pdf');

const YELLOW  = [252, 240, 0];
const BLACK   = [0, 0, 0];
const WHITE   = [255, 255, 255];
const DKGRAY  = [30, 30, 30];
const MDGRAY  = [80, 80, 80];
const LTGRAY  = [160, 160, 160];
const GREEN   = [40, 167, 69];
const RED     = [220, 53, 69];
const SUMMARY_BG = [22, 22, 22];
const VLINE   = [50, 50, 50];

function fmtPct(n, d = 2) { return (n >= 0 ? '+' : '') + n.toFixed(d) + '%'; }
function fmtComma(n) { return n.toLocaleString('en-US'); }

const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function drawVerticalSeparators(doc, topY, bottomY, navWidths, LM) {
  doc.strokeColor(VLINE).lineWidth(0.5);
  let x = LM;
  for (let i = 0; i < 4; i++) {
    x += navWidths[i];
    doc.moveTo(x - 2, topY).lineTo(x - 2, bottomY).stroke();
  }
}

async function run() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db('pnthr_den');

  const dailyNav = await db.collection('pnthr_bt_daily_nav')
    .find({}).sort({ date: 1 }).toArray();

  await client.close();

  const SAMPLE_MONTH = '2020-03';
  const monthDays = dailyNav.filter(d => d.date.startsWith(SAMPLE_MONTH));
  const firstIdx = dailyNav.findIndex(d => d.date === monthDays[0].date);
  const startEq = firstIdx > 0 ? dailyNav[firstIdx - 1].equity : monthDays[0].equity;
  const startSpy = firstIdx > 0 ? dailyNav[firstIdx - 1].spyEquity : monthDays[0].spyEquity;
  const endEq = monthDays[monthDays.length - 1].equity;
  const endSpy = monthDays[monthDays.length - 1].spyEquity;
  const monthRet = ((endEq - startEq) / startEq) * 100;
  const spyMonthRet = ((endSpy - startSpy) / startSpy) * 100;

  const doc = new PDFDocument({ size: 'letter', margin: 0, bufferPages: true });
  doc.pipe(fs.createWriteStream(OUTPUT));

  const LM = 36;
  const RM = 36;
  const PW = 612;
  const CW = PW - LM - RM;
  let y = 40;

  doc.rect(0, 0, PW, 792).fill(BLACK);

  doc.fontSize(11).fillColor(YELLOW).font('Helvetica-Bold')
     .text('COMPREHENSIVE DAILY NAV LOG — MOCKUP v4', LM, y, { width: CW });
  y += 20;
  doc.moveTo(LM, y).lineTo(PW - RM, y).strokeColor(YELLOW).lineWidth(1).stroke();
  y += 12;

  // Column order: DATE, SPY EQUITY, PNTHR EQUITY, OPEN, MTD %, gap, ACTIVITY
  const navCols = ['DATE', 'SPY EQUITY', 'PNTHR EQUITY', 'OPEN', 'MTD %', '', 'ACTIVITY'];
  const ACT_GAP = 20;
  const navWidths = [42, 68, 68, 28, 42, ACT_GAP, CW - 248 - ACT_GAP];

  // ── Month Header — clean ──
  const [yr, mo] = SAMPLE_MONTH.split('-');
  const monthName = MONTH_NAMES[parseInt(mo)] + ' ' + yr;

  doc.fontSize(7.5).fillColor(YELLOW).font('Helvetica-Bold')
     .text(monthName.toUpperCase(), LM, y, { width: 120, lineBreak: false });
  doc.fillColor(LTGRAY).font('Helvetica').fontSize(6.5)
     .text('Start: $' + fmtComma(Math.round(startEq)), LM + 80, y, { width: 140, lineBreak: false });

  y += 14;

  // ── Table Header — WHITE font ──
  const aligns = ['left', 'right', 'right', 'right', 'right', 'left', 'center'];
  doc.fontSize(5.5).fillColor(WHITE).font('Helvetica-Bold');
  let hx = LM;
  for (let i = 0; i < navCols.length; i++) {
    if (navCols[i]) {
      doc.text(navCols[i], hx, y, { width: navWidths[i], align: aligns[i], lineBreak: false });
    }
    hx += navWidths[i];
  }
  y += 9;
  doc.moveTo(LM, y).lineTo(PW - RM, y).strokeColor(MDGRAY).lineWidth(0.5).stroke();
  y += 4;

  const dataStartY = y;

  // ── Daily Rows ──
  let totalOpened = 0;
  let totalClosed = 0;
  let totalPnl = 0;
  const lastDayOpen = monthDays[monthDays.length - 1].openPositions;

  for (const d of monthDays) {
    const mtd = ((d.equity - startEq) / startEq) * 100;
    const mtdColor = mtd >= 0 ? GREEN : RED;

    let activity = '';
    if (d.opened && d.opened.length > 0) {
      totalOpened += d.opened.length;
      const openStr = d.opened.map(t => t.ticker).join(', ');
      activity += 'OPEN: ' + openStr;
    }
    if (d.closed && d.closed.length > 0) {
      totalClosed += d.closed.length;
      for (const t of d.closed) totalPnl += (t.pnl || 0);
      const closeStr = d.closed.map(t => {
        const pnlStr = t.pnl >= 0 ? '+$' + Math.round(t.pnl) : '-$' + Math.abs(Math.round(t.pnl));
        return t.ticker + ' ' + pnlStr;
      }).join(', ');
      activity += (activity ? '\n' : '') + 'CLOSE: ' + closeStr;
    }

    const activityW = navWidths[6];
    doc.fontSize(5.5).font('Helvetica');
    const actH = activity ? doc.heightOfString(activity, { width: activityW }) : 8;
    const rowH = Math.max(10, actH + 2);

    const dayLabel = d.date.slice(5);
    let x = LM;
    doc.fontSize(6).font('Helvetica');
    // DATE — gray
    doc.fillColor(LTGRAY).text(dayLabel, x, y, { width: navWidths[0], lineBreak: false }); x += navWidths[0];
    // SPY EQUITY — always gray
    doc.fillColor(LTGRAY).text('$' + fmtComma(Math.round(d.spyEquity)), x, y, { width: navWidths[1], align: 'right', lineBreak: false }); x += navWidths[1];
    // PNTHR EQUITY — YELLOW
    doc.fillColor(YELLOW).text('$' + fmtComma(Math.round(d.equity)), x, y, { width: navWidths[2], align: 'right', lineBreak: false }); x += navWidths[2];
    // OPEN — YELLOW
    doc.fillColor(YELLOW).text(String(d.openPositions), x, y, { width: navWidths[3], align: 'right', lineBreak: false }); x += navWidths[3];
    // MTD %
    doc.fillColor(mtdColor).text(fmtPct(mtd, 2), x, y, { width: navWidths[4], align: 'right', lineBreak: false }); x += navWidths[4];
    x += navWidths[5];

    if (activity) {
      doc.fontSize(5.5).fillColor(WHITE).text(activity, x, y, { width: activityW, lineBreak: true });
    } else {
      doc.fontSize(5.5).fillColor(MDGRAY).text('-', x, y, { width: activityW, lineBreak: false });
    }

    y += rowH;
  }

  // ── MONTHLY SUMMARY ROW — 1 size larger ──
  y += 2;
  const summaryRowY = y - 2;
  const summaryRowH = 18;
  doc.rect(LM - 4, summaryRowY, CW + 8, summaryRowH).fill(SUMMARY_BG);
  doc.moveTo(LM, summaryRowY).lineTo(PW - RM, summaryRowY).strokeColor(MDGRAY).lineWidth(0.5).stroke();

  const pnlStr = totalPnl >= 0 ? '+$' + fmtComma(Math.round(totalPnl)) : '-$' + fmtComma(Math.abs(Math.round(totalPnl)));
  const summaryActivity = `${totalOpened} opened, ${totalClosed} closed, ${lastDayOpen} open, ${pnlStr} net P&L`;
  const moAbbr = MONTH_NAMES[parseInt(mo)].toUpperCase();

  let sx = LM;
  const sumFontSize = 7; // 1 size larger than daily rows
  doc.fontSize(sumFontSize).font('Helvetica-Bold');
  // MAR TOTAL — yellow
  doc.fillColor(YELLOW).text(moAbbr + ' TOTAL', sx, y + 1, { width: navWidths[0] + 4, lineBreak: false }); sx += navWidths[0];
  // SPY return — gray
  doc.fillColor(LTGRAY).text(fmtPct(spyMonthRet, 2), sx, y + 1, { width: navWidths[1], align: 'right', lineBreak: false }); sx += navWidths[1];
  // PNTHR return — green/red
  doc.fillColor(monthRet >= 0 ? GREEN : RED)
     .text(fmtPct(monthRet, 2), sx, y + 1, { width: navWidths[2], align: 'right', lineBreak: false }); sx += navWidths[2];
  // End-of-month open positions
  doc.fillColor(YELLOW).text(String(lastDayOpen), sx, y + 1, { width: navWidths[3], align: 'right', lineBreak: false }); sx += navWidths[3];
  // Final MTD
  doc.fillColor(monthRet >= 0 ? GREEN : RED)
     .text(fmtPct(monthRet, 2), sx, y + 1, { width: navWidths[4], align: 'right', lineBreak: false }); sx += navWidths[4];
  sx += navWidths[5];
  // Activity summary: X opened, Y open, +$Z net P&L
  doc.fontSize(6.5).font('Helvetica-Bold').fillColor(LTGRAY)
     .text(summaryActivity, sx, y + 1, { width: navWidths[6], lineBreak: false });

  // ── Vertical separators ──
  const vlineBottom = summaryRowY + summaryRowH;
  drawVerticalSeparators(doc, dataStartY, vlineBottom, navWidths, LM);

  y = summaryRowY + summaryRowH + 4;

  // ── Separator Line ──
  doc.moveTo(LM, y).lineTo(PW - RM, y).strokeColor(MDGRAY).lineWidth(0.5).stroke();
  y += 10;

  doc.rect(0, 788, PW, 4).fill(YELLOW);

  doc.end();
  console.log('Mockup v4 generated:', OUTPUT);
}

run().catch(err => { console.error(err); process.exit(1); });
