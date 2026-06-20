// PNTHR Tree Fund - AI-300 Universe Members PDF Generator
// Generates the AI-300 universe / index members PDF for the PNTHR Tree Fund, LP.
// Matches PNTHR Data Room design language (black background, yellow accents, panther logo).
//
// Usage: cd server && node scripts/aiUniverse/generateTreeIndexMembers.js
// Output: ~/Downloads/PNTHR_Tree_Fund_AI300_Universe_Members_v3.3.pdf

import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { SECTORS, FUND_META } from './aiUniverseData.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../');
const LOGO_PATH       = path.resolve(REPO_ROOT, 'client/public/pnthr-funds-logo-white-bg.png');
const PNTHR_HEAD_PATH = path.resolve(REPO_ROOT, 'client/src/assets/panther head.png');

const OUTPUT_DOWNLOADS = path.join(os.homedir(), 'Downloads', `PNTHR_Tree_Fund_AI300_Universe_Members_${FUND_META.version}.pdf`);
const OUTPUT_REPO      = path.resolve(REPO_ROOT, `PNTHR_Tree_Fund_AI300_Universe_Members_${FUND_META.version}.pdf`);

// ── Brand Colors (match generatePyramidPDF.js) ───────────────────────────────
const YELLOW  = [252, 240, 0];
const BLACK   = [0, 0, 0];
const WHITE   = [255, 255, 255];
const DKGRAY  = [30, 30, 30];
const MDGRAY  = [80, 80, 80];
const LTGRAY  = [160, 160, 160];
const GREEN   = [40, 167, 69];
const RED     = [220, 53, 69];

const W = 612, H = 792;
const LM = 50, RM = W - 50, CW = RM - LM;
const BOTTOM = H - 50;
const PAGE_HEADER_H = 30;
const CONTENT_TOP = PAGE_HEADER_H + 20;

// ── Build PDF ────────────────────────────────────────────────────────────────
function build() {
  // ── Sanitize shared universe data for the Tree fund (this process only) ──────
  // aiUniverseData.js is shared with the Elite white paper; its per-holding thesis
  // text carries "AI Elite" branding. Rewrite to neutral AI-300 universe language
  // at render time so the Tree document contains no Elite naming. This mutates the
  // imported objects in THIS Node process only and does not affect the Elite
  // generator, which runs separately.
  const deElite = (t) => typeof t === 'string'
    ? t.replace(/AI Elite Universe/g, 'AI-300 universe').replace(/AI Elite/g, 'AI-300').replace(/\s*\bElite\b/g, '')
    : t;
  FUND_META.fullName = 'PNTHR Tree Fund, LP';
  FUND_META.fundName = 'PNTHR Tree Fund';
  for (const sector of SECTORS) {
    sector.name = deElite(sector.name);
    sector.thesis = deElite(sector.thesis);
    for (const h of (sector.holdings || [])) {
      h.name = deElite(h.name);
      h.thesis = deElite(h.thesis);
    }
  }

  const doc = new PDFDocument({
    size: 'letter',
    margins: { top: 50, bottom: 50, left: 50, right: 50 },
    autoFirstPage: false,
    bufferPages: true,
    info: {
      Title: 'PNTHR Tree Fund - AI-300 Universe Members',
      Author: 'PNTHR Funds',
      Subject: 'PNTHR Tree Fund, LP - AI-300 Universe Members',
    }
  });

  // Page-number tracking, populated as we render, then used to fix up TOC at end
  const pageRefs = {
    letter: 0,
    glance: 0,
    sectors: {},      // sectorId -> page number
    methodology: 0,
    flow: 0,
    disclosures: 0,
  };

  // Pipe to BOTH downloads and repo (so it ships with the codebase too)
  doc.pipe(fs.createWriteStream(OUTPUT_DOWNLOADS));
  doc.pipe(fs.createWriteStream(OUTPUT_REPO));

  let pageNum = 0;

  function newBlackPage(isCover = false) {
    doc.addPage();
    doc.fillColor('#000000').rect(0, 0, W, H).fill();
    pageNum++;
    if (!isCover) {
      doc.fillColor('#000000').rect(0, 0, W, PAGE_HEADER_H).fill();
      doc.moveTo(0, PAGE_HEADER_H).lineTo(W, PAGE_HEADER_H).strokeColor(YELLOW).lineWidth(1.5).stroke();
      doc.fontSize(7).font('Helvetica-Bold').fillColor(YELLOW)
         .text('PNTHR FUNDS', LM, 10, { continued: true, lineBreak: false });
      doc.fillColor(LTGRAY).font('Helvetica')
         .text('  |  PNTHR Tree Fund  |  Index Members ' + FUND_META.version, { lineBreak: false });
      doc.fillColor(LTGRAY).fontSize(7).font('Helvetica')
         .text('Page ' + pageNum, LM, 10, { width: CW, align: 'right', lineBreak: false });
    }
  }

  function pageFooter() {
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.moveTo(LM, H - 40).lineTo(RM, H - 40).strokeColor(MDGRAY).lineWidth(0.3).stroke();
    doc.fontSize(6.5).fillColor(LTGRAY);
    doc.text(`PNTHR FUNDS  -  TREE FUND  -  CONFIDENTIAL  -  ${FUND_META.date}  -  pnthrfunds.com`,
             LM, H - 30, { align: 'center', width: CW, lineBreak: false });
    doc.page.margins.bottom = saved;
  }

  function sectionTitle(text, y, color = YELLOW) {
    doc.fontSize(13).fillColor(color).font('Helvetica-Bold')
       .text(text, LM, y, { width: CW, lineBreak: false });
    doc.moveTo(LM, y + 16).lineTo(LM + CW, y + 16).strokeColor(color).lineWidth(0.5).stroke();
    return y + 24;
  }

  function checkPage(y, needed = 40) {
    if (y + needed > BOTTOM - 35) {
      pageFooter();
      newBlackPage();
      return CONTENT_TOP;
    }
    return y;
  }

  // ════════════════════════════════════════════════════════════════════════
  // PAGE 1: COVER
  // ════════════════════════════════════════════════════════════════════════
  newBlackPage(true);

  // White header bar with PNTHR FUNDS logo + AI-300 UNIVERSE tagline
  const COVER_HEADER_H = 160;
  doc.fillColor('#FFFFFF').rect(0, 0, W, COVER_HEADER_H).fill();
  if (fs.existsSync(LOGO_PATH)) {
    const logoW = 260;
    const logoH = logoW / 2.46;  // aspect 2500x1016 = 2.46:1
    const logoX = (W - logoW) / 2;
    const logoY = 16;
    doc.image(LOGO_PATH, logoX, logoY, { width: logoW });
    // AI-300 UNIVERSE tagline below the logo (replaces the legacy CQF subtitle)
    const taglineY = logoY + logoH + 6;
    doc.fontSize(11).fillColor('#000000').font('Helvetica-Bold')
       .text('AI-300 UNIVERSE', LM, taglineY, { width: CW, align: 'center', characterSpacing: 2, lineBreak: false });
  }

  // Yellow line below header
  doc.moveTo(0, COVER_HEADER_H).lineTo(W, COVER_HEADER_H).strokeColor(YELLOW).lineWidth(2).stroke();

  // Cover title
  doc.fontSize(24).fillColor(YELLOW).font('Helvetica-Bold')
     .text('PNTHR Tree Fund', LM, COVER_HEADER_H + 30, { width: CW, align: 'center', lineBreak: false });
  doc.fontSize(14).fillColor(WHITE).font('Helvetica')
     .text('AI-300 Universe Members', LM, COVER_HEADER_H + 64, { width: CW, align: 'center', lineBreak: false });
  doc.fontSize(10).fillColor(LTGRAY).font('Helvetica')
     .text(`${FUND_META.totalHoldings} Holdings  |  ${FUND_META.totalSectors} AI Sub-Sectors  |  ${FUND_META.version}  |  ${FUND_META.date}`,
           LM, COVER_HEADER_H + 86, { width: CW, align: 'center', lineBreak: false });

  doc.moveTo(LM + 100, COVER_HEADER_H + 110).lineTo(RM - 100, COVER_HEADER_H + 110)
     .strokeColor(YELLOW).lineWidth(1).stroke();

  // Fund Overview block
  let fy = COVER_HEADER_H + 125;
  doc.fontSize(9).fillColor(WHITE).font('Helvetica-Bold').text('FUND OVERVIEW', LM, fy, { lineBreak: false });
  fy += 14;
  doc.fontSize(8).fillColor(LTGRAY).font('Helvetica');
  const fundInfo = [
    ['Fund Name',       'PNTHR Tree Fund, LP'],
    ['Strategy',        'Systematic AI-300 momentum (long/short authorized; long-only implementation)'],
    ['Universe',        `AI-300 Index, ${FUND_META.totalHoldings} curated U.S.-listed AI equities`],
    ['Sub-Sectors',     `${FUND_META.totalSectors} thematic AI sub-sectors`],
    ['Entry Signal',    'New 42-week-high (210-trading-day) breakout'],
    ['Index Weighting', 'Capped market-cap, monthly rebalance (first trading day)'],
    ['Benchmark',       'AI-300 Index (PAI300); S&P 500'],
    ['Geographic',      'U.S. exchanges only (NYSE / NASDAQ)'],
  ];
  for (const [label, val] of fundInfo) {
    doc.fillColor(YELLOW).text(label, LM + 8, fy, { width: 130, lineBreak: false });
    doc.fillColor(WHITE).text(val, LM + 145, fy, { width: 360, lineBreak: false });
    fy += 13;
  }

  // Sector Allocation grid
  fy += 8;
  doc.moveTo(LM, fy).lineTo(LM + 200, fy).strokeColor(YELLOW).lineWidth(1).stroke();
  fy += 8;
  doc.fontSize(9).fillColor(WHITE).font('Helvetica-Bold').text('TARGET SECTOR ALLOCATION', LM, fy, { lineBreak: false });
  fy += 16;

  // 4-column grid of sector tiles
  const tileW = (CW - 24) / 4;
  const tileH = 36;
  for (let i = 0; i < SECTORS.length; i++) {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const tx = LM + col * (tileW + 8);
    const ty = fy + row * (tileH + 6);
    doc.rect(tx, ty, tileW, tileH).fillAndStroke(DKGRAY, MDGRAY);
    doc.fontSize(11).fillColor(YELLOW).font('Helvetica-Bold')
       .text(SECTORS[i].weight + '%', tx + 4, ty + 4, { width: tileW - 8, lineBreak: false });
    doc.fontSize(5.5).fillColor(LTGRAY).font('Helvetica')
       .text(SECTORS[i].name, tx + 4, ty + 19, { width: tileW - 8, lineBreak: true });
  }

  // PNTHR head + signature quote
  fy += Math.ceil(SECTORS.length / 4) * (tileH + 6) + 16;
  if (fs.existsSync(PNTHR_HEAD_PATH)) {
    const headW = 60;
    doc.image(PNTHR_HEAD_PATH, LM + 20, fy, { width: headW });
    doc.fontSize(8).fillColor(WHITE).font('Helvetica-Oblique')
       .text('"The most comprehensive AI investment universe ever assembled, every link in the AI value chain, hunted by PNTHR signals."',
              LM + 95, fy + 6, { width: CW - 95, lineBreak: true });
    doc.fontSize(9).fillColor(YELLOW).font('Helvetica-Bold')
       .text('~ PNTHR', LM + 95, fy + 50, { width: CW - 95, lineBreak: false });
  }

  // Disclaimer footer on cover, set bottom margin to 0 to prevent auto-pagination
  const coverSavedBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.fontSize(7).fillColor(LTGRAY).font('Helvetica')
     .text('CONFIDENTIAL, For Qualified Investors Only, Not an Offer to Sell Securities',
            LM, H - 60, { align: 'center', width: CW, lineBreak: false });
  doc.fontSize(6.5).fillColor(LTGRAY).font('Helvetica')
     .text('Past performance is not indicative of future results. See full disclaimers on final page.',
            LM, H - 49, { align: 'center', width: CW, lineBreak: false });
  doc.fontSize(6.5).fillColor(LTGRAY)
     .text(`PNTHR FUNDS  -  TREE FUND  -  CONFIDENTIAL  -  ${FUND_META.date}  -  pnthrfunds.com`,
            LM, H - 30, { align: 'center', width: CW, lineBreak: false });
  doc.page.margins.bottom = coverSavedBottom;

  // ════════════════════════════════════════════════════════════════════════
  // PAGE 2: TOC PLACEHOLDER, will be filled in at the end with real page nums
  // ════════════════════════════════════════════════════════════════════════
  newBlackPage();
  pageFooter();
  const TOC_PAGE_INDEX = doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1;

  // ════════════════════════════════════════════════════════════════════════
  // PAGE 3: LETTER FROM PNTHR
  // ════════════════════════════════════════════════════════════════════════
  newBlackPage();
  pageRefs.letter = pageNum;
  let y = sectionTitle('LETTER FROM PNTHR', CONTENT_TOP);
  y += 8;
  doc.fontSize(9).fillColor(WHITE).font('Helvetica');

  const letter = [
    'Dear Qualified Investor,',
    '',
    'Artificial Intelligence is the single largest capital reallocation event of our lifetimes. Trillions of dollars are being spent on chips, power, networking, data centers, robotics, drugs, drones, and software, and yet most public AI funds capture only the surface layer: the handful of hyperscalers and a few semiconductor names.',
    '',
    `We built the AI-300 to map the whole field: a hand-curated universe of ${FUND_META.totalHoldings} U.S.-listed AI-pure-play and AI-leveraged names, organized into 16 sub-sectors that trace the AI value chain from sand and silicon, through power and networking, to robots, drugs, and quantum computing.`,
    '',
    'Every name in this universe earned its spot, and every name carries a clear AI thesis. The index that organizes them is rules-based and capped market-cap weighted; it rebalances monthly and is reconstituted transparently.',
    '',
    'The PNTHR Tree Fund hunts this universe with one disciplined rule: it buys names breaking out to new 42-week highs, sizes each position to a fixed risk budget, and rides each winner behind a trailing stop until the trend breaks. One rule, applied to every name, every day.',
    '',
    'This document maps the universe and the index behind it, and the thesis behind every holding. The Fund strategy, economics, risks, and disclosures are detailed in the Private Placement Memorandum and the Fund Intelligence Report.',
    '',
    'Welcome to the hunt.',
    '',
    '~ PNTHR',
  ];
  for (const para of letter) {
    if (para === '') { y += 6; continue; }
    if (para.startsWith('~ ')) {
      doc.fontSize(11).fillColor(YELLOW).font('Helvetica-Bold').text(para, LM, y, { width: CW, lineBreak: true });
      y = doc.y + 6;
    } else if (para === 'Dear Qualified Investor,' || para === 'Hunt well.') {
      doc.fontSize(9).fillColor(WHITE).font('Helvetica').text(para, LM, y, { width: CW, lineBreak: true });
      y = doc.y + 4;
    } else {
      doc.fontSize(9).fillColor(WHITE).font('Helvetica').text(para, LM, y, { width: CW, lineBreak: true, align: 'justify' });
      y = doc.y + 4;
    }
    if (y > BOTTOM - 60) { pageFooter(); newBlackPage(); y = CONTENT_TOP; }
  }
  pageFooter();

  // ════════════════════════════════════════════════════════════════════════
  // PAGE 4: UNIVERSE AT A GLANCE
  // ════════════════════════════════════════════════════════════════════════
  newBlackPage();
  pageRefs.glance = pageNum;
  y = sectionTitle('THE PNTHR AI UNIVERSE AT A GLANCE', CONTENT_TOP);
  y += 8;

  doc.fontSize(9).fillColor(WHITE).font('Helvetica')
     .text(`PNTHR has assembled ${FUND_META.totalHoldings} U.S.-listed AI-pure-play and AI-leveraged equities, the broadest AI investment universe of any public investment vehicle. This basket is approximately 3-7x more comprehensive than AIQ (95 holdings), BOTZ (45), ROBO (78), IRBO (110), or ARTY (70), and is curated entirely by PNTHR's investment team using a disciplined AI-300 selection process: companies whose core revenue or product roadmap is materially leveraged to the artificial intelligence super-cycle.`,
           LM, y, { width: CW, align: 'justify', lineBreak: true });
  y = doc.y + 12;

  // Sector summary table
  y = sectionTitle('SECTOR ALLOCATION TABLE', y);
  y += 6;

  // Header
  doc.fontSize(7).fillColor(YELLOW).font('Helvetica-Bold');
  doc.text('#',          LM,       y, { width: 18,  lineBreak: false });
  doc.text('SUB-SECTOR', LM + 22,  y, { width: 280, lineBreak: false });
  doc.text('TARGET %',   LM + 308, y, { width: 60,  align: 'right', lineBreak: false });
  doc.text('HOLDINGS',   LM + 372, y, { width: 60,  align: 'right', lineBreak: false });
  doc.text('CONVICTION', LM + 436, y, { width: 76,  align: 'right', lineBreak: false });
  y += 12;
  doc.moveTo(LM, y - 2).lineTo(LM + CW, y - 2).strokeColor(MDGRAY).lineWidth(0.3).stroke();

  doc.fontSize(7).font('Helvetica');
  for (const s of SECTORS) {
    const conviction = s.weight >= 10 ? 'CORE' : s.weight >= 5 ? 'HIGH' : s.weight >= 2 ? 'MEDIUM' : 'RADAR';
    const conColor = s.weight >= 10 ? YELLOW : s.weight >= 5 ? GREEN : s.weight >= 2 ? WHITE : LTGRAY;
    doc.fillColor(LTGRAY).text(s.id.toString(), LM, y, { width: 18, lineBreak: false });
    doc.fillColor(WHITE).text(s.name, LM + 22, y, { width: 280, lineBreak: false });
    doc.fillColor(YELLOW).text(s.weight + '%', LM + 308, y, { width: 60, align: 'right', lineBreak: false });
    doc.fillColor(WHITE).text(s.holdings.length.toString(), LM + 372, y, { width: 60, align: 'right', lineBreak: false });
    doc.fillColor(conColor).text(conviction, LM + 436, y, { width: 76, align: 'right', lineBreak: false });
    y += 11;
  }

  y += 8;
  doc.moveTo(LM, y).lineTo(LM + CW, y).strokeColor(YELLOW).lineWidth(0.5).stroke();
  y += 6;
  doc.fontSize(7).fillColor(YELLOW).font('Helvetica-Bold').text('TOTAL', LM, y, { width: 50, lineBreak: false });
  doc.fillColor(WHITE).text(`${FUND_META.totalSectors} sub-sectors`, LM + 50, y, { width: 252, lineBreak: false });
  const totalWeight = SECTORS.reduce((sum, s) => sum + s.weight, 0);
  doc.fillColor(YELLOW).text(totalWeight + '%', LM + 308, y, { width: 60, align: 'right', lineBreak: false });
  doc.fillColor(YELLOW).text(FUND_META.totalHoldings.toString(), LM + 372, y, { width: 60, align: 'right', lineBreak: false });

  y += 22;
  y = sectionTitle('CONVICTION TIER LEGEND', y);
  y += 6;
  const legend = [
    ['CORE',   '10%+ weight',   '"Largest index weights, core AI value-chain names."',  YELLOW],
    ['HIGH',   '5-9% weight',   '"High-conviction thematic concentration."',                GREEN],
    ['MEDIUM', '2-4% weight',   '"Important exposure with disciplined sizing."',            WHITE],
    ['RADAR',  '< 2% weight',   '"Smallest index weights, emerging or niche AI exposure."',LTGRAY],
  ];
  for (const [tier, range, desc, color] of legend) {
    doc.fontSize(8).fillColor(color).font('Helvetica-Bold').text(tier, LM + 8, y, { width: 60, lineBreak: false });
    doc.fontSize(8).fillColor(LTGRAY).font('Helvetica').text(range, LM + 72, y, { width: 80, lineBreak: false });
    doc.fontSize(8).fillColor(WHITE).font('Helvetica-Oblique').text(desc, LM + 158, y, { width: CW - 158, lineBreak: false });
    y += 14;
  }

  pageFooter();

  // ════════════════════════════════════════════════════════════════════════
  // SECTOR PAGES (one section page + holdings tiles per sector)
  // ════════════════════════════════════════════════════════════════════════
  for (const sector of SECTORS) {
    // SECTOR COVER PAGE
    newBlackPage();
    pageRefs.sectors[sector.id] = pageNum;
    y = CONTENT_TOP + 30;

    // Big sector number
    doc.fontSize(70).fillColor(YELLOW).font('Helvetica-Bold')
       .text(sector.id.toString().padStart(2, '0'), LM, y, { width: 120, lineBreak: false });

    // Sector name + meta
    const nameY = y + 4;
    doc.fontSize(20).fillColor(WHITE).font('Helvetica-Bold')
       .text(sector.name, LM + 130, nameY, { width: CW - 130, lineBreak: true });
    const sectorY = doc.y + 4;
    doc.fontSize(10).fillColor(YELLOW).font('Helvetica')
       .text(`Target Allocation: ${sector.weight}%   |   ${sector.holdings.length} Holdings`,
              LM + 130, sectorY, { width: CW - 130, lineBreak: false });

    y = Math.max(y + 90, doc.y + 30);

    // Yellow divider
    doc.moveTo(LM, y).lineTo(LM + CW, y).strokeColor(YELLOW).lineWidth(1).stroke();
    y += 16;

    // Sector thesis
    doc.fontSize(9).fillColor(WHITE).font('Helvetica-Oblique')
       .text('PNTHR Sector Thesis', LM, y, { lineBreak: false });
    y += 14;
    doc.fontSize(10).fillColor(WHITE).font('Helvetica')
       .text(sector.thesis, LM, y, { width: CW, align: 'justify', lineBreak: true });
    y = doc.y + 20;

    // Holdings preview list (4 columns of tickers)
    doc.fontSize(8).fillColor(YELLOW).font('Helvetica-Bold')
       .text('HOLDINGS IN THIS SECTOR', LM, y, { lineBreak: false });
    doc.moveTo(LM, y + 12).lineTo(LM + CW, y + 12).strokeColor(YELLOW).lineWidth(0.3).stroke();
    y += 18;

    const colW = CW / 6;
    const tickersPerCol = Math.ceil(sector.holdings.length / 6);
    doc.fontSize(8).fillColor(WHITE).font('Helvetica-Bold');
    for (let i = 0; i < sector.holdings.length; i++) {
      const col = Math.floor(i / tickersPerCol);
      const row = i % tickersPerCol;
      const tx = LM + col * colW;
      const ty = y + row * 11;
      doc.text(sector.holdings[i].ticker, tx, ty, { width: colW - 4, lineBreak: false });
    }
    y += tickersPerCol * 11 + 16;

    pageFooter();

    // HOLDING DETAIL PAGES, investment thesis for each company
    newBlackPage();
    y = sectionTitle(`SECTOR ${sector.id.toString().padStart(2, '0')}  |  ${sector.name.toUpperCase()}`, CONTENT_TOP);
    y += 8;
    doc.fontSize(8).fillColor(LTGRAY).font('Helvetica-Oblique')
       .text(`PNTHR Investment Thesis, ${sector.holdings.length} holdings  |  Target ${sector.weight}%`,
              LM, y, { width: CW, lineBreak: false });
    y += 16;

    for (let i = 0; i < sector.holdings.length; i++) {
      const h = sector.holdings[i];

      // Estimate height: ticker line ~14 + name line ~12 + thesis ~5 lines × 10 = 50, plus padding = ~80
      // Be conservative
      const estimatedHeight = 78;
      y = checkPage(y, estimatedHeight);

      // Yellow ticker on left
      doc.fontSize(11).fillColor(YELLOW).font('Helvetica-Bold')
         .text(h.ticker, LM, y, { width: 70, lineBreak: false });
      // Company name in white on right
      doc.fontSize(9).fillColor(WHITE).font('Helvetica-Bold')
         .text(h.name, LM + 75, y + 1, { width: CW - 75, lineBreak: false });
      y += 14;

      // PNTHR Investment Thesis paragraph
      doc.fontSize(8).fillColor(LTGRAY).font('Helvetica')
         .text(h.thesis, LM, y, { width: CW, align: 'justify', lineBreak: true });
      y = doc.y + 10;

      // Subtle divider between holdings
      if (i < sector.holdings.length - 1) {
        doc.moveTo(LM, y - 4).lineTo(LM + 80, y - 4).strokeColor(DKGRAY).lineWidth(0.3).stroke();
        y += 4;
      }
    }
    pageFooter();
  }

  // ════════════════════════════════════════════════════════════════════════
  // ACT III, METHODOLOGY: AI-300 Index Construction + Tree trading rule
  // ════════════════════════════════════════════════════════════════════════
  newBlackPage();
  pageRefs.methodology = pageNum;
  y = sectionTitle('ACT III  |  THE METHODOLOGY', CONTENT_TOP);
  y += 14;

  y = sectionTitle('AI-300 INDEX CONSTRUCTION', y, WHITE);
  y += 8;
  doc.fontSize(9).fillColor(WHITE).font('Helvetica');
  const idxText = [
    'The AI-300 is a rules-based index. It is not hand-weighted, discretionary, or flow-tilted. Each name enters at its capped market-capitalization weight, and the index is reconstituted on a fixed monthly schedule.',
    '',
    'At each rebalance, raw float-adjusted market-cap weights are computed for every constituent, then capped: no single name may exceed 4.0% of the index, and the six mega-cap hyperscalers (MSFT, GOOGL, META, AMZN, ORCL, IBM) are capped at 1.5% each. Weight freed by the caps is redistributed pro-rata to the uncapped names. Between rebalances, weights drift naturally with price, so winners are allowed to run within the cap.',
    '',
    'Synthetic share counts are set on each rebalance so the index value does not jump on rebalance day. New constituents (for example, post-IPO names) join at the first rebalance after their first available price, and the index divisor adjusts so the addition does not distort the level.',
  ];
  for (const para of idxText) {
    if (para === '') { y += 4; continue; }
    doc.text(para, LM, y, { width: CW, align: 'justify', lineBreak: true });
    y = doc.y + 4;
  }
  y += 8;
  y = checkPage(y, 100);
  y = sectionTitle('INDEX RULES', y, WHITE);
  y += 6;
  const idxRules = [
    ['Weighting',       'Capped float-adjusted market capitalization.'],
    ['Single-Name Cap', 'No constituent above 4.0% of the index.'],
    ['Mega-Cap Cap',    'MSFT, GOOGL, META, AMZN, ORCL, IBM capped at 1.5% each.'],
    ['Rebalance',       'Monthly, on the first trading day of each month.'],
    ['Base',            'Index base value 1000 on January 3, 2022.'],
    ['Drift',           'Weights drift with price between rebalances (winners run within the cap).'],
    ['Additions',       'New names join at the next rebalance after their first available bar; divisor adjusts.'],
    ['Audit',           'Divisor history and per-rebalance constituent weights are recorded for transparency.'],
  ];
  for (const [label, val] of idxRules) {
    y = checkPage(y, 18);
    doc.fontSize(8).fillColor(YELLOW).font('Helvetica-Bold').text(label, LM + 8, y, { width: 130, lineBreak: false });
    doc.fontSize(8).fillColor(WHITE).font('Helvetica').text(val, LM + 145, y, { width: CW - 145, lineBreak: true });
    y = doc.y + 6;
  }
  pageFooter();

  // ═══════════════════════════════════════════════════════════════════════════════
  // METHODOLOGY PAGE 2: How the Tree trades this universe
  // ═══════════════════════════════════════════════════════════════════════════════
  newBlackPage();
  pageRefs.flow = pageNum;
  y = sectionTitle('HOW THE TREE TRADES THIS UNIVERSE', CONTENT_TOP);
  y += 8;
  doc.fontSize(9).fillColor(WHITE).font('Helvetica');
  const treeText = [
    'This document defines the universe. The PNTHR Tree Fund trades it with a single systematic rule. The index above is the eligible set and the fund benchmark; it is not a trading filter, and the Fund does not weight positions by the index or rotate between sectors.',
    '',
    'ENTRY, NEW 42-WEEK HIGH. Every trading day the system checks each AI-300 name against its prior 210 trading days (about 42 weeks). When a name trades above that prior high, it is a Buy Long breakout. Entry is a resting buy-stop at the breakout level, filled there or at the open on a gap.',
    '',
    'POSITION SIZING, FULL SIZE AT ENTRY. The Fund takes its full intended position at the breakout, with no adding or averaging in. Size is the smaller of 2% of NAV risked to the initial stop and 10% of NAV in position value, then capped by the name 20-day average daily volume so the Fund can execute at scale. Total gross exposure is capped hard at 2.0x NAV.',
    '',
    'EXIT, TRAILING STOP. Each position carries one trailing stop at the lowest low of the prior 10 trading days, minus a penny. It ratchets up only. A break-even rule snaps the stop to the entry price once the trade is sufficiently in profit and confirmed, then the trail resumes. A position is held until its stop is met.',
    '',
    'DIRECTIONAL MANDATE. The Fund is authorized to take long and short positions. The current systematic implementation is long-only; no short positions are taken today. All backtested results reflect the long-only implementation.',
    '',
    'The full strategy, fees, risks, and disclosures are set out in the Confidential Private Placement Memorandum and the Fund Intelligence Report.',
  ];
  for (const para of treeText) {
    if (para === '') { y += 4; continue; }
    y = checkPage(y, 30);
    doc.text(para, LM, y, { width: CW, align: 'justify', lineBreak: true });
    y = doc.y + 4;
  }
  pageFooter();

  // ════════════════════════════════════════════════════════════════════════
  // FINAL: DISCLOSURES
  // ════════════════════════════════════════════════════════════════════════
  newBlackPage();
  pageRefs.disclosures = pageNum;
  y = sectionTitle('IMPORTANT DISCLOSURES & RISK FACTORS', CONTENT_TOP);
  y += 8;

  doc.fontSize(8).fillColor(LTGRAY).font('Helvetica');
  const disclosures = [
    'CONFIDENTIAL, FOR QUALIFIED INVESTORS ONLY. This document is provided on a confidential basis to qualified investors solely for informational purposes. It is not an offer to sell or a solicitation of an offer to buy any security. Any such offer or solicitation may be made only to qualified investors by means of a Confidential Private Placement Memorandum and related subscription documents.',
    '',
    'NOT INVESTMENT ADVICE. This document does not constitute investment, legal, tax, or accounting advice. Recipients should consult their own advisors regarding any matters discussed herein.',
    '',
    'AI-THEMATIC CONCENTRATION RISK. The PNTHR Tree Fund concentrates investments in companies with material exposure to artificial intelligence. As a thematic concentrated strategy, the Fund will exhibit higher volatility than diversified benchmarks and is subject to AI-specific cyclical risk including: hyperscaler capex deceleration, foundation model commoditization, regulatory restrictions on AI deployment, and geopolitical disruption to AI supply chains (particularly U.S.-China semiconductor relations).',
    '',
    'STRATEGY & DRAWDOWN RISK. The Fund follows a concentrated momentum strategy that buys breakouts to new highs and exits on trailing stops. This approach produces a low win rate with a small number of large winners, and it has experienced, and may again experience, large drawdowns (on the order of 50% or more in backtest). The strategy uses leverage up to 2.0x gross and can lose a substantial portion of its value. It is not a hedged, low-volatility, or absolute-return product.',
    '',
    'SMALL-CAP & EMERGING TECHNOLOGY RISK. The Universe includes small-capitalization, micro-cap, and emerging-technology companies (including quantum computing, eVTOL aviation, gene editing, and space-based AI). These positions carry elevated volatility, liquidity risk, and potential for significant loss.',
    '',
    'INTERNATIONAL & ADR RISK. The Universe includes American Depositary Receipts (ADRs) of non-U.S. companies, including Chinese ADRs subject to potential delisting risk, capital controls, and U.S.-China trade-relations disruption.',
    '',
    'HYPOTHETICAL & BACKTESTED PERFORMANCE. Any performance figures referenced for the Tree strategy are hypothetical and backtested. They are derived from the current AI-300 index membership applied to historical prices, which introduces survivorship bias and is likely to overstate results. Backtested performance does not represent actual trading, has inherent limitations, and is not a track record. The Fund has no live track record at the time of publication; actual results will differ and may be materially worse.',
    '',
    'INDEX METHODOLOGY DISCLAIMER. The AI-300 index construction (capped market-cap weighting, monthly rebalance, constituent selection) is proprietary and subject to refinement. Actual constituents and weights may change at any rebalance.',
    '',
    'PAST PERFORMANCE. Past performance is not indicative of future results.',
    '',
    'FORWARD-LOOKING STATEMENTS. This document contains forward-looking statements about AI market trends and individual company prospects. Such statements involve known and unknown risks, uncertainties, and other factors that may cause actual results to differ materially.',
    '',
    'INDEPENDENT VERIFICATION. Investors should independently verify all information contained in this document, including company descriptions, sector classifications, and AI-thesis claims. PNTHR Funds makes no representation as to the accuracy of third-party information.',
    '',
    `© ${new Date().getFullYear()} PNTHR Funds. All rights reserved. PNTHR FUNDS and PNTHR Tree Fund are trademarks of PNTHR Funds.`,
  ];
  for (const para of disclosures) {
    if (para === '') { y += 4; continue; }
    y = checkPage(y, 30);
    doc.text(para, LM, y, { width: CW, align: 'justify', lineBreak: true });
    y = doc.y + 4;
  }

  pageFooter();

  // ════════════════════════════════════════════════════════════════════════
  // FILL IN TOC PAGE with REAL page numbers (computed during render)
  // ════════════════════════════════════════════════════════════════════════
  doc.switchToPage(TOC_PAGE_INDEX);
  let ty = sectionTitle('TABLE OF CONTENTS', CONTENT_TOP);

  ty += 6;
  doc.fontSize(10).fillColor(YELLOW).font('Helvetica-Bold')
     .text('ACT I, THE THESIS', LM, ty, { lineBreak: false });
  ty += 16;
  const realActI = [
    ['Letter from PNTHR',                  String(pageRefs.letter)],
    ['The PNTHR AI Universe at a Glance',  String(pageRefs.glance)],
    ['Sector Allocation & Conviction Tiers', String(pageRefs.glance)],
  ];
  for (const [t, p] of realActI) {
    doc.fontSize(9).fillColor(WHITE).font('Helvetica').text(t, LM + 8, ty, { width: 380, lineBreak: false });
    doc.fontSize(9).fillColor(LTGRAY).text(p, LM + 8, ty, { width: CW - 16, align: 'right', lineBreak: false });
    ty += 14;
  }

  ty += 12;
  doc.fontSize(10).fillColor(YELLOW).font('Helvetica-Bold')
     .text('ACT II, THE 16 SUB-SECTORS', LM, ty, { lineBreak: false });
  ty += 16;
  for (const s of SECTORS) {
    doc.fontSize(9).fillColor(WHITE).font('Helvetica')
       .text(`${s.id}. ${s.name}`, LM + 8, ty, { width: 380, lineBreak: false });
    doc.fontSize(9).fillColor(LTGRAY)
       .text(`${s.weight}%  |  ${s.holdings.length} holdings  |  ${pageRefs.sectors[s.id]}`,
              LM + 8, ty, { width: CW - 16, align: 'right', lineBreak: false });
    ty += 14;
  }

  ty += 12;
  doc.fontSize(10).fillColor(YELLOW).font('Helvetica-Bold')
     .text('ACT III, THE METHODOLOGY', LM, ty, { lineBreak: false });
  ty += 16;
  const realActIII = [
    ['AI-300 Index Construction',          String(pageRefs.methodology)],
    ['Index Rules',                        String(pageRefs.methodology)],
    ['How the Tree Trades This Universe',  String(pageRefs.flow)],
    ['Directional Mandate',                String(pageRefs.flow)],
  ];
  for (const [t, p] of realActIII) {
    doc.fontSize(9).fillColor(WHITE).font('Helvetica').text(t, LM + 8, ty, { width: 380, lineBreak: false });
    doc.fontSize(9).fillColor(LTGRAY).text(p, LM + 8, ty, { width: CW - 16, align: 'right', lineBreak: false });
    ty += 14;
  }

  ty += 12;
  doc.fontSize(10).fillColor(YELLOW).font('Helvetica-Bold')
     .text('ACT IV, DISCLOSURES', LM, ty, { lineBreak: false });
  ty += 16;
  doc.fontSize(9).fillColor(WHITE).font('Helvetica')
     .text('Important Disclosures & Risk Factors', LM + 8, ty, { width: 380, lineBreak: false });
  doc.fontSize(9).fillColor(LTGRAY)
     .text(String(pageRefs.disclosures), LM + 8, ty, { width: CW - 16, align: 'right', lineBreak: false });

  doc.end();
  console.log(`✓ Generated PNTHR Tree Fund - AI-300 Universe Members:`);
  console.log(`  -> ${OUTPUT_DOWNLOADS}`);
  console.log(`  -> ${OUTPUT_REPO}`);
  console.log(`  Total pages: ${pageNum}`);
  console.log(`  Total holdings: ${FUND_META.totalHoldings} across ${FUND_META.totalSectors} sectors`);
}

build();
