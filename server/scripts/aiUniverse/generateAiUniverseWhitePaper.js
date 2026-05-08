// PNTHR AI Universe, White Paper PDF Generator
// Generates a comprehensive PDF white paper for the PNTHR AI Elite Universe Fund.
// Matches PNTHR Data Room design language (black background, yellow accents, panther logo).
//
// Usage: cd server && node scripts/aiUniverse/generateAiUniverseWhitePaper.js
// Output: ~/Downloads/PNTHR_AI_Universe_White_Paper_v1.0.pdf

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

const OUTPUT_DOWNLOADS = path.join(os.homedir(), 'Downloads', `PNTHR_AI_Universe_White_Paper_${FUND_META.version}.pdf`);
const OUTPUT_REPO      = path.resolve(REPO_ROOT, `PNTHR_AI_Universe_White_Paper_${FUND_META.version}.pdf`);

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
  const doc = new PDFDocument({
    size: 'letter',
    margins: { top: 50, bottom: 50, left: 50, right: 50 },
    autoFirstPage: false,
    bufferPages: true,
    info: {
      Title: 'PNTHR AI Universe White Paper',
      Author: 'PNTHR Funds',
      Subject: 'PNTHR AI Elite Universe Fund, Investment Thesis White Paper',
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
         .text('  |  PNTHR AI Elite Universe Fund  |  White Paper ' + FUND_META.version, { lineBreak: false });
      doc.fillColor(LTGRAY).fontSize(7).font('Helvetica')
         .text('Page ' + pageNum, LM, 10, { width: CW, align: 'right', lineBreak: false });
    }
  }

  function pageFooter() {
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.moveTo(LM, H - 40).lineTo(RM, H - 40).strokeColor(MDGRAY).lineWidth(0.3).stroke();
    doc.fontSize(6.5).fillColor(LTGRAY);
    doc.text(`PNTHR FUNDS  -  AI ELITE UNIVERSE FUND  -  CONFIDENTIAL  -  ${FUND_META.date}  -  pnthrfunds.com`,
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

  // White header bar with PNTHR FUNDS logo + AI ELITE UNIVERSE FUND tagline
  const COVER_HEADER_H = 160;
  doc.fillColor('#FFFFFF').rect(0, 0, W, COVER_HEADER_H).fill();
  if (fs.existsSync(LOGO_PATH)) {
    const logoW = 260;
    const logoH = logoW / 2.46;  // aspect 2500x1016 = 2.46:1
    const logoX = (W - logoW) / 2;
    const logoY = 16;
    doc.image(LOGO_PATH, logoX, logoY, { width: logoW });
    // AI ELITE UNIVERSE FUND tagline below the logo (replaces the legacy CQF subtitle)
    const taglineY = logoY + logoH + 6;
    doc.fontSize(11).fillColor('#000000').font('Helvetica-Bold')
       .text('AI ELITE UNIVERSE FUND', LM, taglineY, { width: CW, align: 'center', characterSpacing: 2, lineBreak: false });
  }

  // Yellow line below header
  doc.moveTo(0, COVER_HEADER_H).lineTo(W, COVER_HEADER_H).strokeColor(YELLOW).lineWidth(2).stroke();

  // Cover title
  doc.fontSize(24).fillColor(YELLOW).font('Helvetica-Bold')
     .text('The PNTHR AI Elite Universe', LM, COVER_HEADER_H + 30, { width: CW, align: 'center', lineBreak: false });
  doc.fontSize(14).fillColor(WHITE).font('Helvetica')
     .text('Investment Thesis White Paper', LM, COVER_HEADER_H + 64, { width: CW, align: 'center', lineBreak: false });
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
    ['Fund Name',       'PNTHR AI Elite Universe Fund'],
    ['Strategy',        'Systematic Long/Short AI-Themed U.S. Equity'],
    ['Universe Size',   `${FUND_META.totalHoldings} curated AI-pure-play U.S.-listed equities`],
    ['Sub-Sectors',     `${FUND_META.totalSectors} thematic AI sub-sectors with target allocations`],
    ['Signal Engine',   'PNTHR Pulse Weighting (Trend × Momentum × Flow)'],
    ['Rebalance',       'Weekly (Friday close), aligned with PNTHR Friday Pipeline'],
    ['Benchmark',       'AIQ (Global X AI ETF), BOTZ (Robotics/AI ETF), QQQ'],
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
     .text(`PNTHR FUNDS  -  AI ELITE UNIVERSE FUND  -  CONFIDENTIAL  -  ${FUND_META.date}  -  pnthrfunds.com`,
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
    'Artificial Intelligence is the single largest capital reallocation event of our lifetimes. Trillions of dollars are being spent on chips, power, networking, data centers, robotics, drugs, drones, and software, and yet most public AI funds capture only the surface layer: the 6 hyperscalers and a handful of semiconductor names.',
    '',
    'We built the PNTHR AI Elite Universe to fix that.',
    '',
    'This is not an index. It is not equal-weighted. It is not cap-weighted. It is a hand-curated universe of 305 U.S.-listed AI-pure-play and AI-leverage names, organized into 16 sub-sectors that map cleanly to the AI value chain, from sand and silicon, through power and networking, to robots, drugs, and quantum computing.',
    '',
    'Every name in this universe earned its spot. Every name has a clear AI thesis. Every name is hunted weekly by PNTHR\'s proprietary signal engine, the same multi-timeframe EMA crossover and conviction-scoring system that has powered our flagship Carnivore Quant Fund.',
    '',
    'When AI capital rotates, and it does, week to week, month to month, the PNTHR signals see it first. A surge in AI Power flow before the broader market notices. An optical bandwidth name breaking out three weeks before its quarterly print. A quantum lottery ticket lighting up on volume before the headline.',
    '',
    'We don\'t guess where AI dollars are flowing. We measure it.',
    '',
    'This white paper documents the universe. The methodology. The thesis behind every holding. It is the most comprehensive AI investment thesis assembled publicly anywhere, three to seven times broader than AIQ, BOTZ, ROBO, IRBO, or ARTY. It is the hunting ground.',
    '',
    'If you\'re going to step into this jungle, get behind the PNTHR. He\'s a killing machine. We got you. Welcome to the hunt.',
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
     .text(`PNTHR has assembled ${FUND_META.totalHoldings} U.S.-listed AI-pure-play and AI-leveraged equities, the broadest AI investment universe of any public investment vehicle. This basket is approximately 3-7x more comprehensive than AIQ (95 holdings), BOTZ (45), ROBO (78), IRBO (110), or ARTY (70), and is curated entirely by PNTHR's investment team using a proprietary "AI Elite" filter: companies whose core revenue or product roadmap is materially leveraged to the artificial intelligence super-cycle.`,
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
    ['CORE',   '10%+ weight',   '"Where AI capital must flow, non-negotiable holdings."',  YELLOW],
    ['HIGH',   '5-9% weight',   '"High-conviction thematic concentration."',                GREEN],
    ['MEDIUM', '2-4% weight',   '"Important exposure with disciplined sizing."',            WHITE],
    ['RADAR',  '< 2% weight',   '"Small starter positions, capital not flowing here YET."',LTGRAY],
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
  // ACT III, METHODOLOGY: PNTHR Pulse Weighting
  // ════════════════════════════════════════════════════════════════════════
  newBlackPage();
  pageRefs.methodology = pageNum;
  y = sectionTitle('ACT III  |  THE METHODOLOGY', CONTENT_TOP);
  y += 14;

  y = sectionTitle('PNTHR PULSE WEIGHTING FRAMEWORK', y, WHITE);
  y += 8;
  doc.fontSize(9).fillColor(WHITE).font('Helvetica');

  const methodologyText = [
    'Cap-weighted ETFs let mega-caps dominate at the expense of small-cap conviction. Equal-weighted ETFs reward stagnant names equally with leaders. Fundamentals-weighted indices fail when many AI pure-plays have no earnings to weight against.',
    '',
    'The PNTHR AI Elite Universe uses a proprietary scoring methodology, the PNTHR Pulse Score, that allocates capital based on technical strength and capital flow, not market capitalization. The result: NVIDIA at score 50 receives less weight than a small-cap optical name at score 95. Strength wins. Size is irrelevant.',
    '',
    'The Pulse Score is computed weekly from three components:',
  ];
  for (const para of methodologyText) {
    if (para === '') { y += 4; continue; }
    doc.text(para, LM, y, { width: CW, align: 'justify', lineBreak: true });
    y = doc.y + 4;
  }

  y += 8;

  // Component blocks
  const components = [
    {
      title: 'TREND  (50 points) ,  Multi-Timeframe Alignment',
      desc:  'Above weekly OpEMA (sector-optimized 18-26 week EMA): +20 pts. Above daily 21 EMA: +15 pts. Daily-Weekly aligned (both bullish or both bearish): +15 pts. Perfect bullish alignment scores +50 (strong LONG); perfect bearish scores -50 (strong SHORT). Multi-timeframe alignment is THE filter that separates real moves from whipsaws.',
    },
    {
      title: 'MOMENTUM  (25 points) ,  Relative Outperformance',
      desc:  '1-week return vs AI universe median (0-10 pts). 1-month return (0-10 pts). 3-month return (0-5 pts). All measured RELATIVE to the AI universe, so a small cap up 30% in a +5% AI tape scores higher than NVDA up 8%. Strength is rewarded over scale.',
    },
    {
      title: 'FLOW  (25 points) ,  Money Showing Up',
      desc:  'Relative volume (RVOL) above 1.5x: 0-10 pts. Accumulation Days (up days on rising volume in last 20): 0-10 pts. Sector heat relative to AI universe: 0-5 pts. This component captures real-time capital rotation, the names where institutional flow is arriving NOW.',
    },
  ];

  for (const c of components) {
    y = checkPage(y, 80);
    doc.fontSize(9).fillColor(YELLOW).font('Helvetica-Bold').text(c.title, LM, y, { width: CW, lineBreak: false });
    y += 14;
    doc.fontSize(8).fillColor(WHITE).font('Helvetica').text(c.desc, LM + 8, y, { width: CW - 8, align: 'justify', lineBreak: true });
    y = doc.y + 12;
  }

  y = checkPage(y, 80);
  y = sectionTitle('PORTFOLIO CONSTRUCTION RULES', y, WHITE);
  y += 6;
  const rules = [
    ['Floor',    'Every active holding gets at least 0.10% of fund (no zero positions; preserves radar exposure).'],
    ['Ceiling',  'No single name above 4.0% of fund (concentration limit prevents over-reliance on one AI name).'],
    ['Hyperscaler Cap', 'No individual mega-cap (MSFT, GOOGL, META, AMZN) above 1.5% of fund (prevents AI ETF imitation).'],
    ['Radar Threshold', 'Pulse Score below 30 auto-drops to 0.10% scout position (sleeping bet, ready to scale up).'],
    ['Long Book',  'Pulse Score above +30 takes an active long position, scaled by score within sector.'],
    ['Short Book', 'Pulse Score below -30 takes an active short hedge, scaled by absolute score (capped at 30% of fund total).'],
    ['Rebalance',  'Weekly Friday close, aligned with PNTHR Friday Pipeline + Kill scoring engine.'],
  ];
  for (const [label, val] of rules) {
    y = checkPage(y, 18);
    doc.fontSize(8).fillColor(YELLOW).font('Helvetica-Bold').text(label, LM + 8, y, { width: 130, lineBreak: false });
    doc.fontSize(8).fillColor(WHITE).font('Helvetica').text(val, LM + 145, y, { width: CW - 145, lineBreak: true });
    y = doc.y + 6;
  }

  pageFooter();

  // ════════════════════════════════════════════════════════════════════════
  // METHODOLOGY PAGE 2: Capital Flow + Daily/Weekly Signals
  // ════════════════════════════════════════════════════════════════════════
  newBlackPage();
  pageRefs.flow = pageNum;
  y = sectionTitle('CAPITAL FLOW ANALYSIS  |  WHERE THE DOLLARS ARE MOVING', CONTENT_TOP);
  y += 8;
  doc.fontSize(9).fillColor(WHITE).font('Helvetica');

  const flowText = [
    'PNTHR\'s sector weights are not static. Each weekly rebalance evaluates which AI sub-sectors are RECEIVING capital flow versus stagnating. Heat-mapped sectors get over-weighted within the framework; cold sectors stay at radar levels.',
    '',
    'As of the publication of this white paper, PNTHR\'s capital flow analysis identifies the following regime:',
    '',
  ];
  for (const para of flowText) {
    if (para === '') { y += 4; continue; }
    doc.text(para, LM, y, { width: CW, align: 'justify', lineBreak: true });
    y = doc.y + 4;
  }

  y += 4;

  // HOT / WARM / COOL table
  const flowRegime = [
    { state: 'HOT', color: GREEN, sectors: 'AI Power & Energy, AI Compute & Semis, AI Optical & Networking, AI Healthcare & Genomics, Drones/Space/Defense AI', note: 'Hyperscaler capex continues. Power deals signed weekly. Optical bandwidth crisis intensifies.' },
    { state: 'WARM', color: YELLOW, sectors: 'AI Cloud & Data Centers, Robotics & Autonomous, AI Software & Agents, AI Cybersecurity, Quantum Computing, Materials & Industrial', note: 'Steady capital flow but no acceleration. Holding at base weights.' },
    { state: 'COOL', color: LTGRAY, sectors: 'AI Hyperscalers, AI Fintech, AI Ad-Tech, AI Vertical SaaS, International AI ADRs', note: 'Already over-owned (hyperscalers) or rotating out (fintech). Held at radar weight, ready to scale up when flow returns.' },
  ];
  for (const r of flowRegime) {
    y = checkPage(y, 60);
    doc.fontSize(10).fillColor(r.color).font('Helvetica-Bold').text(r.state, LM, y, { width: 60, lineBreak: false });
    doc.fontSize(8).fillColor(WHITE).font('Helvetica').text(r.sectors, LM + 70, y, { width: CW - 70, lineBreak: true });
    y = doc.y + 4;
    doc.fontSize(8).fillColor(LTGRAY).font('Helvetica-Oblique').text(r.note, LM + 70, y, { width: CW - 70, lineBreak: true });
    y = doc.y + 12;
  }

  y += 8;
  y = sectionTitle('DAILY + WEEKLY SIGNAL LAYER', y, WHITE);
  y += 6;

  doc.fontSize(8).fillColor(WHITE).font('Helvetica');
  const signalText = [
    'PNTHR signals operate on two timeframes for maximum trade-list resolution:',
    '',
    'WEEKLY SIGNALS (WBL / WSS), The PNTHR flagship signal: weekly close above/below sector-optimized 18-26W EMA. Slow, confirmed, regime-defining. Used for primary trend regime and Kill scoring.',
    '',
    'DAILY SIGNALS (DBL / DSS), Newly added for the AI Universe: daily close crossing 21 EMA, gated by weekly trend regime. Provides early entry triggers, names that fire DBL while WBL is still pending get faster entries at lower size, scaling up on weekly confirmation.',
    '',
    'TRADE HIERARCHY, DBL + WBL aligned = highest conviction long. DBL alone (weekly pending) = early entry, lighter size. DSS while WBL still active = early heads-up before weekly flip. This multi-timeframe stack catches AI rotation 1-3 weeks ahead of the broader market.',
  ];
  for (const para of signalText) {
    if (para === '') { y += 4; continue; }
    y = checkPage(y, 30);
    doc.fontSize(8).fillColor(WHITE).font('Helvetica').text(para, LM, y, { width: CW, align: 'justify', lineBreak: true });
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
    'AI-THEMATIC CONCENTRATION RISK. The PNTHR AI Elite Universe Fund concentrates investments in companies with material exposure to artificial intelligence. As a thematic concentrated strategy, the Fund will exhibit higher volatility than diversified benchmarks and is subject to AI-specific cyclical risk including: hyperscaler capex deceleration, foundation model commoditization, regulatory restrictions on AI deployment, and geopolitical disruption to AI supply chains (particularly U.S.-China semiconductor relations).',
    '',
    'SMALL-CAP & EMERGING TECHNOLOGY RISK. The Universe includes small-capitalization, micro-cap, and emerging-technology companies (including quantum computing, eVTOL aviation, gene editing, and space-based AI). These positions carry elevated volatility, liquidity risk, and potential for significant loss.',
    '',
    'INTERNATIONAL & ADR RISK. The Universe includes American Depositary Receipts (ADRs) of non-U.S. companies, including Chinese ADRs subject to potential delisting risk, capital controls, and U.S.-China trade-relations disruption. ADR positions are deliberately held at small RADAR weight to manage geopolitical exposure.',
    '',
    'METHODOLOGY DISCLAIMER. The PNTHR Pulse Score weighting methodology is proprietary and subject to refinement. Target sector allocations represent baseline weights subject to capital-flow tilts. Actual portfolio weights may deviate from documented targets based on real-time signal output and risk management overlays.',
    '',
    'PAST PERFORMANCE. Past performance is not indicative of future results. The PNTHR AI Elite Universe Fund is a forward-looking strategy with no live track record at time of publication.',
    '',
    'FORWARD-LOOKING STATEMENTS. This document contains forward-looking statements about AI market trends, capital flows, and individual company prospects. Such statements involve known and unknown risks, uncertainties, and other factors that may cause actual results to differ materially.',
    '',
    'INDEPENDENT VERIFICATION. Investors should independently verify all information contained in this document, including company descriptions, sector classifications, and AI-thesis claims. PNTHR Funds makes no representation as to the accuracy of third-party information.',
    '',
    `© ${new Date().getFullYear()} PNTHR Funds. All rights reserved. PNTHR FUNDS™, PNTHR AI Elite Universe™, and PNTHR Pulse Score™ are trademarks of PNTHR Funds.`,
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
    ['PNTHR Pulse Weighting Framework',                String(pageRefs.methodology)],
    ['Portfolio Construction Rules',                   String(pageRefs.methodology)],
    ['Capital Flow Analysis & Sector Rotation',        String(pageRefs.flow)],
    ['Daily + Weekly Signal Layer (WBL/WSS + DBL/DSS)', String(pageRefs.flow)],
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
  console.log(`✓ Generated white paper:`);
  console.log(`  -> ${OUTPUT_DOWNLOADS}`);
  console.log(`  -> ${OUTPUT_REPO}`);
  console.log(`  Total pages: ${pageNum}`);
  console.log(`  Total holdings: ${FUND_META.totalHoldings} across ${FUND_META.totalSectors} sectors`);
}

build();
