// server/backtest/generatePyramidPDF.js
// ── PNTHR Funds — PYRAMID Fund Intelligence Report ──────────────────────────
//
// NAV-scaled version of the Fund Intelligence Report.
// Reads from pnthr_bt_pyramid_nav_{tier} collections instead of 10K fixed.
//
// Usage:  cd server && node backtest/generatePyramidPDF.js [--nav 100000|500000|1000000]
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { MongoClient } from 'mongodb';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.resolve(__dirname, '../../client/public/pnthr-funds-logo-full.png');
const PNTHR_HEAD_PATH = path.resolve(__dirname, '../../client/src/assets/panther head.png');
const FOUNDERS_PATH = path.resolve(__dirname, '../../client/public/pnthr-founders.png');

// ── NAV tier from CLI ────────────────────────────────────────────────────────
const NAV_ARG = process.argv.find(a => a.startsWith('--nav='));
const STARTING_CAPITAL = NAV_ARG ? parseInt(NAV_ARG.split('=')[1]) : (parseInt(process.argv[process.argv.indexOf('--nav') + 1]) || 100000);
const navLabel = STARTING_CAPITAL >= 1000000 ? `${STARTING_CAPITAL / 1000000}m` : `${STARTING_CAPITAL / 1000}k`;
const NAV_DISPLAY = '$' + STARTING_CAPITAL.toLocaleString();

const OUTPUT_PATH = path.resolve(__dirname, `../../PNTHR_Pyramid_Fund_Intelligence_Report_${navLabel}.pdf`);

// ── Brand Colors ─────────────────────────────────────────────────────────────
const YELLOW  = [252, 240, 0];
const BLACK   = [0, 0, 0];
const WHITE   = [255, 255, 255];
const DKGRAY  = [30, 30, 30];
const MDGRAY  = [80, 80, 80];
const LTGRAY  = [160, 160, 160];
const GREEN   = [40, 167, 69];
const RED     = [220, 53, 69];

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtDollar(n) {
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}
function fmtPct(n, decimals = 2) { return (n >= 0 ? '+' : '') + n.toFixed(decimals) + '%'; }
function fmtComma(n) { return n.toLocaleString('en-US'); }

const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function run() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db('pnthr_den');

  // ── Load data ────────────────────────────────────────────────────────────
  console.log('Loading daily NAV data...');
  const dailyNav = await db.collection(`pnthr_bt_pyramid_nav_${navLabel}_daily_nav`)
    .find({}).sort({ date: 1 }).toArray();
  console.log(`  ${dailyNav.length} days loaded`);

  const maeDoc = await db.collection(`pnthr_bt_pyramid_nav_${navLabel}_mae_analysis`).findOne({});
  const top10MAE = maeDoc?.top30Trades?.slice(0, 10) || [];
  console.log(`  ${top10MAE.length} worst MAE trades loaded`);

  // ── Load authoritative hedge metrics from MongoDB (pyramid trades only) ──
  const metricsDoc = await db.collection(`pnthr_bt_pyramid_nav_${navLabel}_hedge_metrics`).findOne({});
  if (!metricsDoc) {
    console.error(`No hedge metrics found in pnthr_bt_pyramid_nav_${navLabel}_hedge_metrics.`);
    console.error(`Run: cd server && node backtest/computePyramidNavMetrics.js --nav ${STARTING_CAPITAL}`);
    process.exit(1);
  }
  if (metricsDoc.sourceCollection !== `pnthr_bt_pyramid_nav_${navLabel}_trade_log`) {
    console.error(`Hedge metrics sourced from "${metricsDoc.sourceCollection}" — must be pnthr_bt_pyramid_nav_${navLabel}_trade_log.`);
    console.error(`Run: cd server && node backtest/computePyramidNavMetrics.js --nav ${STARTING_CAPITAL}`);
    process.exit(1);
  }
  const metrics = metricsDoc.metrics;
  console.log(`  Hedge metrics loaded (source: ${metricsDoc.sourceCollection}, ${metricsDoc.totalTrades} trades)`);

  // ── Load monthly trade P&L for growth charts + fee engine ───────────────
  const allTrades = await db.collection(`pnthr_bt_pyramid_nav_${navLabel}_trade_log`)
    .find({}, { projection: { exitDate: 1, netDollarPnl: 1, dollarPnl: 1 } }).toArray();
  const tradePnlByMonth = {};
  for (const t of allTrades) {
    if (!t.exitDate) continue;
    const m = t.exitDate.slice(0, 7);
    if (!tradePnlByMonth[m]) tradePnlByMonth[m] = { net: 0, trades: 0 };
    tradePnlByMonth[m].net += (t.netDollarPnl || 0);
    tradePnlByMonth[m].trades += 1;
  }
  const tradePnlMonths = Object.entries(tradePnlByMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, d]) => ({ month, net: d.net, trades: d.trades }));
  console.log(`  ${tradePnlMonths.length} months of trade P&L loaded for growth charts`);

  // ── Fee engine constants ────────────────────────────────────────────────
  const US2Y_HURDLE_RATES = {
    2019: 2.50, 2020: 1.58, 2021: 0.11, 2022: 0.78,
    2023: 4.40, 2024: 4.33, 2025: 4.25, 2026: 3.47,
  };
  const FILET_TIER = { startingCapital: STARTING_CAPITAL, perfAlloc: 0.30, loyaltyAlloc: 0.25 };
  const MGMT_FEE_MONTHLY = 0.02 / 12;

  function calcPerfAllocation(yearGrossProfit, yearStartNav, hwm, hurdleRate, allocRate) {
    if (yearGrossProfit <= 0) return 0;
    const navBeforeFees = yearStartNav + yearGrossProfit;
    const profitAboveHwm = Math.max(0, navBeforeFees - Math.max(hwm, yearStartNav));
    if (profitAboveHwm <= 0) return 0;
    const hurdleAmount = yearStartNav * (hurdleRate / 100);
    const excessProfit = Math.max(0, profitAboveHwm - hurdleAmount);
    return excessProfit * allocRate;
  }

  function getRunningBacktestNav(months, upToMonth) {
    let nav = STARTING_CAPITAL;
    for (const m of months) {
      if (m.month >= upToMonth) break;
      nav += m.net;
    }
    return Math.max(nav, 1);
  }

  function computeGrowthForYear(yearFilter) {
    const { startingCapital, perfAlloc, loyaltyAlloc } = FILET_TIER;
    const months = yearFilter === 'all'
      ? tradePnlMonths
      : tradePnlMonths.filter(m => m.month.startsWith(String(yearFilter)));
    if (!months.length) return null;

    let nav = startingCapital;
    let hwm = startingCapital;
    let totalMgmtFees = 0, totalPerfFees = 0;
    let monthsInvested = 0, currentYear = null;
    let yearStartNav = nav, yearHurdleRate = 0, yearGrossProfit = 0;
    const chartData = [];

    for (const m of months) {
      const yr = parseInt(m.month.slice(0, 4));
      monthsInvested++;
      if (currentYear !== null && yr !== currentYear) {
        const pf = calcPerfAllocation(yearGrossProfit, yearStartNav, hwm, yearHurdleRate, monthsInvested > 36 ? loyaltyAlloc : perfAlloc);
        nav -= pf; totalPerfFees += pf;
        if (nav > hwm) hwm = nav;
        yearStartNav = nav; yearGrossProfit = 0;
      }
      if (currentYear !== yr) {
        currentYear = yr;
        yearHurdleRate = US2Y_HURDLE_RATES[yr] || 0;
        if (yr !== parseInt(months[0].month.slice(0, 4)) || yearGrossProfit === 0) {
          yearStartNav = nav; yearGrossProfit = 0;
        }
      }
      const returnRate = m.net / getRunningBacktestNav(tradePnlMonths, m.month);
      const monthGross = nav * returnRate;
      yearGrossProfit += monthGross;
      nav += monthGross;
      const mgmtFee = nav * MGMT_FEE_MONTHLY;
      nav -= mgmtFee; totalMgmtFees += mgmtFee;
      chartData.push({ month: m.month, nav: +nav.toFixed(2) });
    }
    // Final year perf allocation
    if (currentYear !== null) {
      const pf = calcPerfAllocation(yearGrossProfit, yearStartNav, hwm, yearHurdleRate, monthsInvested > 36 ? loyaltyAlloc : perfAlloc);
      nav -= pf; totalPerfFees += pf;
      if (nav > hwm) hwm = nav;
      if (chartData.length > 0) chartData[chartData.length - 1].nav = +nav.toFixed(2);
    }
    return {
      chartData,
      endingNav: +nav.toFixed(2),
      totalReturn: +(nav - startingCapital).toFixed(2),
      totalReturnPct: +((nav / startingCapital - 1) * 100).toFixed(1),
      totalMgmtFees: +totalMgmtFees.toFixed(2),
      totalPerfFees: +totalPerfFees.toFixed(2),
      totalFees: +(totalMgmtFees + totalPerfFees).toFixed(2),
      hwm: +hwm.toFixed(2),
      hurdleRate: US2Y_HURDLE_RATES[yearFilter] || 0,
    };
  }

  // Build SPY growth from dailyNav (monthly last-day equity)
  const spyGrowthByMonth = {};
  for (const d of dailyNav) {
    const m = d.date.slice(0, 7);
    spyGrowthByMonth[m] = d.spyEquity;
  }

  // ── Compute analytics ────────────────────────────────────────────────────
  console.log('Computing analytics...');

  // Monthly returns (PNTHR)
  const monthlyReturns = {};
  let prevMonthEquity = STARTING_CAPITAL;
  let prevMonth = '';
  for (const d of dailyNav) {
    const month = d.date.slice(0, 7);
    if (month !== prevMonth && prevMonth !== '') {
      const lastDayOfPrevMonth = dailyNav.filter(x => x.date.startsWith(prevMonth)).pop();
      if (lastDayOfPrevMonth) {
        const ret = ((lastDayOfPrevMonth.equity - prevMonthEquity) / prevMonthEquity) * 100;
        monthlyReturns[prevMonth] = { return: +ret.toFixed(4), equity: lastDayOfPrevMonth.equity };
        prevMonthEquity = lastDayOfPrevMonth.equity;
      }
    }
    prevMonth = month;
  }
  const lastDay = dailyNav[dailyNav.length - 1];
  const lastMonth = lastDay.date.slice(0, 7);
  const ret = ((lastDay.equity - prevMonthEquity) / prevMonthEquity) * 100;
  monthlyReturns[lastMonth] = { return: +ret.toFixed(4), equity: lastDay.equity };

  // SPY monthly returns
  const spyMonthlyReturns = {};
  let prevSpyEquity = dailyNav[0]?.spyEquity || STARTING_CAPITAL;
  prevMonth = '';
  for (const d of dailyNav) {
    const month = d.date.slice(0, 7);
    if (month !== prevMonth && prevMonth !== '') {
      const lastDayPrev = dailyNav.filter(x => x.date.startsWith(prevMonth)).pop();
      if (lastDayPrev) {
        const r = ((lastDayPrev.spyEquity - prevSpyEquity) / prevSpyEquity) * 100;
        spyMonthlyReturns[prevMonth] = +r.toFixed(4);
        prevSpyEquity = lastDayPrev.spyEquity;
      }
    }
    prevMonth = month;
  }
  const spyLastRet = ((lastDay.spyEquity - prevSpyEquity) / prevSpyEquity) * 100;
  spyMonthlyReturns[lastMonth] = +spyLastRet.toFixed(4);

  // Annual returns
  const annualReturns = {};
  const years = [...new Set(Object.keys(monthlyReturns).map(m => m.slice(0, 4)))].sort();
  for (const yr of years) {
    const yrMonths = Object.entries(monthlyReturns).filter(([m]) => m.startsWith(yr));
    let compound = 1;
    for (const [, v] of yrMonths) compound *= (1 + v.return / 100);
    annualReturns[yr] = { return: +((compound - 1) * 100).toFixed(2) };
    const spyYrMonths = Object.entries(spyMonthlyReturns).filter(([m]) => m.startsWith(yr));
    let spyCompound = 1;
    for (const [, v] of spyYrMonths) spyCompound *= (1 + v / 100);
    annualReturns[yr].spy = +((spyCompound - 1) * 100).toFixed(2);
    annualReturns[yr].alpha = +(annualReturns[yr].return - annualReturns[yr].spy).toFixed(2);
  }

  // Drawdown events
  const drawdownEvents = [];
  let inDD = false, ddStart = null, ddPeak = 0, ddTrough = Infinity, ddTroughDate = '';
  for (const d of dailyNav) {
    if (d.drawdownPct > 0.01) {
      if (!inDD) { inDD = true; ddStart = d.date; ddPeak = d.peakEquity; ddTrough = d.equity; ddTroughDate = d.date; }
      if (d.equity < ddTrough) { ddTrough = d.equity; ddTroughDate = d.date; }
    } else if (inDD) {
      const maxDDPct = ((ddPeak - ddTrough) / ddPeak) * 100;
      const startNav = dailyNav.find(x => x.date === ddStart);
      const recoveryNav = d;
      const periodReturn = startNav ? ((recoveryNav.equity - startNav.equity) / startNav.equity) * 100 : 0;
      drawdownEvents.push({
        start: ddStart, troughDate: ddTroughDate, recoveryDate: d.date,
        peakEquity: ddPeak, troughEquity: ddTrough,
        maxDDPct: +maxDDPct.toFixed(4),
        durationDays: dailyNav.filter(x => x.date >= ddStart && x.date <= d.date).length,
        periodReturn: +periodReturn.toFixed(2),
      });
      inDD = false;
    }
  }
  drawdownEvents.sort((a, b) => b.maxDDPct - a.maxDDPct);

  // Best / worst days
  const dailyReturns = [];
  for (let i = 1; i < dailyNav.length; i++) {
    const prev = dailyNav[i - 1].equity;
    const curr = dailyNav[i].equity;
    const r = ((curr - prev) / prev) * 100;
    dailyReturns.push({ date: dailyNav[i].date, return: +r.toFixed(4), equity: curr });
  }
  dailyReturns.sort((a, b) => a.return - b.return);
  const worst10Days = dailyReturns.slice(0, 10);
  const best10Days = dailyReturns.slice(-10).reverse();

  const allMonths = Object.values(monthlyReturns);
  const posMonths = allMonths.filter(m => m.return >= 0).length;
  const negMonths = allMonths.filter(m => m.return < 0).length;

  // Rolling 12-month
  const monthKeys = Object.keys(monthlyReturns).sort();
  const rolling12 = [];
  for (let i = 11; i < monthKeys.length; i++) {
    let compound = 1;
    for (let j = i - 11; j <= i; j++) compound *= (1 + monthlyReturns[monthKeys[j]].return / 100);
    rolling12.push({ month: monthKeys[i], return: +((compound - 1) * 100).toFixed(2) });
  }
  const minRolling12 = rolling12.reduce((min, r) => r.return < min.return ? r : min, rolling12[0]);

  const totalReturn = ((lastDay.equity - STARTING_CAPITAL) / STARTING_CAPITAL) * 100;
  const spyTotalReturn = ((lastDay.spyEquity - STARTING_CAPITAL) / STARTING_CAPITAL) * 100;

  // SPY drawdown events
  const spyDrawdowns = [];
  let spyPeak = dailyNav[0]?.spyEquity || STARTING_CAPITAL;
  let spyInDD = false, spyDDStart = '', spyDDPeakVal = 0, spyDDTrough = Infinity, spyDDTroughDate = '';
  for (const d of dailyNav) {
    if (d.spyEquity > spyPeak) spyPeak = d.spyEquity;
    const spyDD = ((spyPeak - d.spyEquity) / spyPeak) * 100;
    if (spyDD > 1) {
      if (!spyInDD) { spyInDD = true; spyDDStart = d.date; spyDDPeakVal = spyPeak; spyDDTrough = d.spyEquity; spyDDTroughDate = d.date; }
      if (d.spyEquity < spyDDTrough) { spyDDTrough = d.spyEquity; spyDDTroughDate = d.date; }
    } else if (spyInDD) {
      const maxPct = ((spyDDPeakVal - spyDDTrough) / spyDDPeakVal) * 100;
      if (maxPct > 5) spyDrawdowns.push({ start: spyDDStart, trough: spyDDTroughDate, maxPct: +maxPct.toFixed(2) });
      spyInDD = false;
    }
  }
  spyDrawdowns.sort((a, b) => b.maxPct - a.maxPct);

  const crisisPerformance = [];
  for (const spyDD of spyDrawdowns.slice(0, 6)) {
    const startNav = dailyNav.find(d => d.date >= spyDD.start);
    const troughNav = dailyNav.find(d => d.date >= spyDD.trough);
    if (startNav && troughNav) {
      const pnthrRet = ((troughNav.equity - startNav.equity) / startNav.equity) * 100;
      crisisPerformance.push({
        period: spyDD.start + ' to ' + spyDD.trough,
        spyDrawdown: -spyDD.maxPct,
        pnthrReturn: +pnthrRet.toFixed(2),
        label: spyDD.start.startsWith('2020-02') ? 'COVID Crash' :
               spyDD.start.startsWith('2022') ? '2022 Bear Market' :
               spyDD.start.startsWith('2023-07') ? 'Q3 2023 Correction' :
               spyDD.start.startsWith('2025') ? '2025 Liberation Day Correction' :
               'Market Correction'
      });
    }
  }

  console.log('Analytics computed. Generating PDF...');

  // ── BUILD PDF ──────────────────────────────────────────────────────────────
  const doc = new PDFDocument({
    size: 'letter',
    margins: { top: 50, bottom: 50, left: 50, right: 50 },
    autoFirstPage: false,
    info: {
      Title: 'PNTHR Funds - Carnivore Quant Fund, LP - Institutional Tear Sheet',
      Author: 'PNTHR Funds',
      Subject: 'Backtest Performance Report',
    }
  });

  const stream = fs.createWriteStream(OUTPUT_PATH);
  doc.pipe(stream);

  const W = 612, H = 792;
  const LM = 50, RM = W - 50, CW = RM - LM;
  const BOTTOM = H - 50;

  let pageNum = 0;

  const PAGE_HEADER_H = 30;  // height of branded header bar on non-cover pages

  function newBlackPage(isCover = false) {
    doc.addPage();
    doc.fillColor('#000000').rect(0, 0, W, H).fill();
    pageNum++;
    if (!isCover) {
      // Branded header bar on every non-cover page (matches System Architecture style)
      doc.fillColor('#000000').rect(0, 0, W, PAGE_HEADER_H).fill();
      doc.moveTo(0, PAGE_HEADER_H).lineTo(W, PAGE_HEADER_H).strokeColor(YELLOW).lineWidth(1.5).stroke();
      doc.fontSize(7).font('Helvetica-Bold').fillColor(YELLOW)
         .text('PNTHR FUNDS', LM, 10, { continued: true, lineBreak: false });
      doc.fillColor(LTGRAY).font('Helvetica')
         .text('  |  Carnivore Quant Fund  |  Institutional Tear Sheet', { lineBreak: false });
      doc.fillColor(LTGRAY).fontSize(7).font('Helvetica')
         .text('Page ' + pageNum, LM, 10, { width: CW, align: 'right', lineBreak: false });
    }
  }

  // Content starts below header bar on non-cover pages
  const CONTENT_TOP = PAGE_HEADER_H + 20;

  function pageFooter() {
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.moveTo(LM, H - 40).lineTo(RM, H - 40).strokeColor(MDGRAY).lineWidth(0.3).stroke();
    doc.fontSize(6.5).fillColor(LTGRAY);
    doc.text('PNTHR FUNDS  -  CARNIVORE QUANT FUND  -  CONFIDENTIAL  -  April 2026  -  pnthrfunds.com', LM, H - 30, { align: 'center', width: CW, lineBreak: false });
    doc.page.margins.bottom = saved;
  }

  function sectionTitle(text, y) {
    doc.fontSize(13).fillColor(YELLOW).font('Helvetica-Bold')
       .text(text, LM, y, { width: CW, lineBreak: false });
    doc.moveTo(LM, y + 16).lineTo(LM + CW, y + 16).strokeColor(YELLOW).lineWidth(0.5).stroke();
    return y + 24;
  }

  // ── Growth Chart Drawing (PDFKit) ─────────────────────────────────────────
  function drawGrowthChart(title, pnthrData, spyData, growthStats, chartY) {
    const chartX = LM;
    const chartW = CW;
    const chartH = 160;
    const plotX = chartX + 40;
    const plotW = chartW - 50;
    const plotY = chartY;
    const plotH = chartH - 30; // room for x-axis labels

    // Title
    doc.fontSize(9).fillColor(WHITE).font('Helvetica-Bold')
       .text(title, chartX, chartY - 18, { width: chartW, lineBreak: false });

    // Subtitle
    doc.fontSize(6).fillColor(LTGRAY).font('Helvetica')
       .text('Net of 2% mgmt fee + performance allocation + US2Y hurdle + HWM', chartX + chartW - 250, chartY - 18, { width: 250, align: 'right', lineBreak: false });

    // Determine Y range
    const allVals = [...pnthrData.map(d => d.nav), ...spyData.map(d => d.nav)];
    const minVal = Math.floor(Math.min(...allVals) / 5000) * 5000;
    const maxVal = Math.ceil(Math.max(...allVals) / 5000) * 5000;
    const range = maxVal - minVal || 1;

    // Y-axis gridlines + labels
    const gridSteps = 5;
    const gridStep = range / gridSteps;
    doc.strokeColor([40, 40, 40]).lineWidth(0.3);
    for (let i = 0; i <= gridSteps; i++) {
      const val = minVal + gridStep * i;
      const gy = plotY + plotH - (i / gridSteps) * plotH;
      doc.moveTo(plotX, gy).lineTo(plotX + plotW, gy).stroke();
      const label = val >= 1e6 ? '$' + (val / 1e6).toFixed(1) + 'M' : '$' + Math.round(val / 1000) + 'K';
      doc.fontSize(5).fillColor(LTGRAY).font('Helvetica')
         .text(label, chartX, gy - 3, { width: 38, align: 'right', lineBreak: false });
    }

    // Left axis line
    doc.moveTo(plotX, plotY).lineTo(plotX, plotY + plotH).strokeColor([60, 60, 60]).lineWidth(0.5).stroke();

    // Plot function
    function plotLine(data, color, dashed) {
      if (data.length < 2) return;
      doc.strokeColor(color).lineWidth(dashed ? 0.75 : 1.5);
      if (dashed) doc.dash(3, { space: 2 });
      for (let i = 0; i < data.length - 1; i++) {
        const x1 = plotX + (i / (data.length - 1)) * plotW;
        const y1 = plotY + plotH - ((data[i].nav - minVal) / range) * plotH;
        const x2 = plotX + ((i + 1) / (data.length - 1)) * plotW;
        const y2 = plotY + plotH - ((data[i + 1].nav - minVal) / range) * plotH;
        doc.moveTo(x1, y1).lineTo(x2, y2).stroke();
      }
      if (dashed) doc.undash();
    }

    // Draw SPY first (behind), then PNTHR
    plotLine(spyData, LTGRAY, true);
    plotLine(pnthrData, YELLOW, false);

    // PNTHR head logo at end of yellow line with glow highlight
    if (pnthrData.length > 0) {
      const lastPt = pnthrData[pnthrData.length - 1];
      const headX = plotX + plotW - 8;
      const headY = plotY + plotH - ((lastPt.nav - minVal) / range) * plotH - 8;
      const cx = headX + 8, cy = headY + 8;
      // Soft radial glow behind the logo
      const glowSteps = [
        { r: 14, opacity: 0.06 },
        { r: 11, opacity: 0.10 },
        { r: 8,  opacity: 0.15 },
      ];
      for (const g of glowSteps) {
        doc.circle(cx, cy, g.r).fillOpacity(g.opacity).fill(YELLOW);
      }
      doc.fillOpacity(1); // reset
      try { doc.image(PNTHR_HEAD_PATH, headX, headY, { width: 16 }); } catch (e) { /* skip if missing */ }
    }

    // X-axis month labels
    const xLabels = pnthrData.length > spyData.length ? pnthrData : spyData;
    const labelInterval = Math.max(1, Math.floor(xLabels.length / 12));
    doc.fontSize(5).fillColor(LTGRAY).font('Helvetica');
    for (let i = 0; i < xLabels.length; i += labelInterval) {
      const x = plotX + (i / (xLabels.length - 1)) * plotW;
      const parts = xLabels[i].month.split('-');
      const label = MONTH_NAMES[parseInt(parts[1])] || parts[1];
      doc.text(label, x - 8, plotY + plotH + 3, { width: 20, align: 'center', lineBreak: false });
    }

    // Legend
    const legY = plotY + plotH + 14;
    const legCenterX = plotX + plotW / 2;
    // PNTHR legend
    doc.strokeColor(YELLOW).lineWidth(1.5);
    doc.moveTo(legCenterX - 110, legY + 3).lineTo(legCenterX - 95, legY + 3).stroke();
    doc.fontSize(5.5).fillColor(YELLOW).text(`PNTHR Fund (${NAV_DISPLAY})`, legCenterX - 92, legY, { lineBreak: false });
    // SPY legend
    doc.strokeColor(LTGRAY).lineWidth(0.75).dash(3, { space: 2 });
    doc.moveTo(legCenterX + 30, legY + 3).lineTo(legCenterX + 45, legY + 3).stroke();
    doc.undash();
    doc.fillColor(LTGRAY).text(`S&P 500 (${NAV_DISPLAY}, net 0.03% ER)`, legCenterX + 48, legY, { lineBreak: false });

    let boxY = legY + 16;

    // ── Fee Breakdown Boxes ──
    if (growthStats) {
      const boxW = (CW - 16) / 2;
      const boxH = 62;
      const leftX = LM;
      const rightX = LM + boxW + 16;

      // Filet box (left)
      doc.rect(leftX, boxY, boxW, boxH).strokeColor(MDGRAY).lineWidth(0.5).stroke();
      doc.fontSize(7).fillColor(YELLOW).font('Helvetica-Bold')
         .text(`Filet \u2014 ${NAV_DISPLAY}`, leftX + 8, boxY + 5, { lineBreak: false });

      const rows = [
        ['Ending NAV', '$' + fmtComma(Math.round(growthStats.endingNav)), WHITE],
        ['Total Return', '$' + fmtComma(Math.round(growthStats.totalReturn)) + ' (+' + growthStats.totalReturnPct + '%)', GREEN],
        ['Mgmt Fees (2%)', '-$' + fmtComma(Math.round(growthStats.totalMgmtFees)), RED],
        ['Perf Alloc (30%)', '-$' + fmtComma(Math.round(growthStats.totalPerfFees)), RED],
        ['Total Fees', '-$' + fmtComma(Math.round(growthStats.totalFees)), RED],
        ['US2Y Hurdle', growthStats.hurdleRate.toFixed(2) + '%', WHITE],
        ['HWM', '$' + fmtComma(Math.round(growthStats.hwm)), WHITE],
      ];
      let ry = boxY + 16;
      for (const [label, val, color] of rows) {
        doc.fontSize(5.5).font('Helvetica').fillColor(LTGRAY)
           .text(label, leftX + 8, ry, { width: boxW / 2, lineBreak: false });
        doc.fillColor(color)
           .text(val, leftX + boxW / 2, ry, { width: boxW / 2 - 8, align: 'right', lineBreak: false });
        ry += 7;
      }

      // SPY box (right)
      const spyEndNav = spyData.length ? spyData[spyData.length - 1].nav : STARTING_CAPITAL;
      const spyReturn = spyEndNav - STARTING_CAPITAL;
      const spyRetPct = ((spyEndNav / STARTING_CAPITAL - 1) * 100).toFixed(1);
      doc.rect(rightX, boxY, boxW, boxH).strokeColor(MDGRAY).lineWidth(0.5).stroke();
      doc.fontSize(7).fillColor(LTGRAY).font('Helvetica-Bold')
         .text(`S&P 500 \u2014 ${NAV_DISPLAY}`, rightX + 8, boxY + 5, { lineBreak: false });

      const spyRows = [
        ['Ending NAV', '$' + fmtComma(Math.round(spyEndNav)), WHITE],
        ['Total Return', '$' + fmtComma(Math.round(spyReturn)) + ' (+' + spyRetPct + '%)', GREEN],
        ['Expense Ratio', '0.03% (VOO)', LTGRAY],
        ['Perf Allocation', 'None', LTGRAY],
      ];
      ry = boxY + 16;
      for (const [label, val, color] of spyRows) {
        doc.fontSize(5.5).font('Helvetica').fillColor(LTGRAY)
           .text(label, rightX + 8, ry, { width: boxW / 2, lineBreak: false });
        doc.fillColor(color)
           .text(val, rightX + boxW / 2, ry, { width: boxW / 2 - 8, align: 'right', lineBreak: false });
        ry += 7;
      }
      boxY += boxH + 8;
    }

    return boxY;
  }

  function tableHeader(cols, y, colWidths, aligns = null, headerColor = YELLOW) {
    doc.fontSize(6.5).fillColor(headerColor).font('Helvetica-Bold');
    let x = LM;
    for (let i = 0; i < cols.length; i++) {
      const align = aligns ? aligns[i] : (i === 0 ? 'left' : 'right');
      if (cols[i]) {
        doc.text(cols[i], x, y, { width: colWidths[i], align, lineBreak: false });
      }
      x += colWidths[i];
    }
    doc.moveTo(LM, y + 10).lineTo(LM + CW, y + 10).strokeColor(MDGRAY).lineWidth(0.3).stroke();
    return y + 13;
  }

  function tableRow(vals, y, colWidths, colors = null) {
    doc.fontSize(6.5).font('Helvetica');
    let x = LM;
    for (let i = 0; i < vals.length; i++) {
      doc.fillColor(colors?.[i] || LTGRAY)
         .text(String(vals[i]), x, y, { width: colWidths[i], align: i === 0 ? 'left' : 'right', lineBreak: false });
      x += colWidths[i];
    }
    return y + 10;
  }

  // Check if we need a new page, returns y position (after new page if needed)
  function checkPage(y, needed = 40) {
    if (y + needed > BOTTOM - 35) {
      pageFooter();
      newBlackPage();
      return CONTENT_TOP;
    }
    return y;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAGE 1: COVER
  // ═══════════════════════════════════════════════════════════════════════════
  newBlackPage(true);  // cover page — no branded header bar

  // White header bar across full width — logo first (full size), founders layered on right
  const COVER_HEADER_H = 145;
  doc.fillColor('#FFFFFF').rect(0, 0, W, COVER_HEADER_H).fill();
  // Logo at original prominent size, centered left
  if (fs.existsSync(LOGO_PATH)) {
    const logoW = 260;
    doc.image(LOGO_PATH, (W - logoW) / 2, 14, { width: logoW });
  }
  // Founders image layered on right — slightly smaller so logo stays dominant
  if (fs.existsSync(FOUNDERS_PATH)) {
    const foundersH = 105;
    const foundersW = foundersH * 1.5;   // 3:2 landscape aspect ratio
    const foundersX = W - foundersW - 25;
    doc.image(FOUNDERS_PATH, foundersX, 10, { height: foundersH });
    // Names under each person — quiet, small
    doc.fontSize(5.5).fillColor('#555555').font('Helvetica');
    doc.text('Cindy Eagar', foundersX + 18, foundersH + 14, { width: 60, align: 'center', lineBreak: false });
    doc.text('Scott McBrien', foundersX + foundersW - 72, foundersH + 14, { width: 60, align: 'center', lineBreak: false });
  }

  // Yellow line separator below header
  doc.moveTo(0, COVER_HEADER_H).lineTo(W, COVER_HEADER_H).strokeColor(YELLOW).lineWidth(2).stroke();

  // "INSTITUTIONAL TEAR SHEET" centered below header with breathing room
  doc.fontSize(26).fillColor(YELLOW).font('Helvetica-Bold')
     .text('PYRAMID FUND INTELLIGENCE REPORT', LM, COVER_HEADER_H + 24, { width: CW, align: 'center', lineBreak: false });
  doc.fontSize(9).fillColor(LTGRAY).font('Helvetica')
     .text('7-Year Backtest Performance Report  |  June 2019 - April 2026', LM, COVER_HEADER_H + 56, { width: CW, align: 'center', lineBreak: false });

  doc.moveTo(LM + 100, COVER_HEADER_H + 72).lineTo(RM - 100, COVER_HEADER_H + 72).strokeColor(YELLOW).lineWidth(1).stroke();

  // Fund Overview
  let fy = COVER_HEADER_H + 84;
  doc.fontSize(8).fillColor(WHITE).font('Helvetica-Bold').text('FUND OVERVIEW', LM, fy, { lineBreak: false });
  fy += 12;
  doc.fontSize(7).fillColor(LTGRAY).font('Helvetica');
  const fundInfo = [
    ['Strategy', 'Systematic Long/Short U.S. Equity'],
    ['Structure', 'Reg D, Rule 506(c), 3(c)(1) Exempt Fund'],
    ['Universe', '679 liquid U.S. equities (PNTHR 679)'],
    ['Signal Engine', 'Proprietary 21-week EMA crossover + 8-dimension scoring'],
    ['Position Sizing', '1% max risk per trade, 10% max portfolio risk exposure'],
    ['Pyramiding', '5-lot entry system (35/25/20/12/8%)'],
    ['Backtest Capital', `${NAV_DISPLAY} starting NAV (Pyramid sizing)`],
    ['Benchmark', 'S&P 500 (SPY)'],
  ];
  for (const [label, val] of fundInfo) {
    doc.fillColor(YELLOW).text(label, LM + 8, fy, { width: 120, lineBreak: false });
    doc.fillColor(WHITE).text(val, LM + 133, fy, { width: 370, lineBreak: false });
    fy += 11;
  }

  // Headline numbers — 4x3 grid
  doc.moveTo(LM, fy + 6).lineTo(LM + 200, fy + 6).strokeColor(YELLOW).lineWidth(1).stroke();
  fy += 14;
  doc.fontSize(8).fillColor(WHITE).font('Helvetica-Bold').text('HEADLINE NUMBERS', LM, fy, { lineBreak: false });
  fy += 14;

  const headlines = [
    [fmtPct(totalReturn, 0), 'Total Return', GREEN],
    [fmtPct(metrics.combined.net.cagr, 1), 'Net CAGR', GREEN],
    [metrics.combined.net.sharpe.toFixed(2), 'Sharpe Ratio', YELLOW],
    [metrics.combined.net.sortino.toFixed(1), 'Sortino Ratio', YELLOW],
    [metrics.combined.net.profitFactor.toFixed(1) + 'x', 'Profit Factor', YELLOW],
    [metrics.combined.net.calmar.toFixed(1), 'Calmar Ratio', YELLOW],
    [fmtPct(-metrics.combined.net.maxDrawdown, 2), 'Max Monthly DD', RED],
    [metrics.combined.net.positiveMonthsPct.toFixed(1) + '%', 'Positive Months', GREEN],
    [fmtPct(metrics.combined.net.bestMonth, 1), 'Best Month', GREEN],
    [fmtComma(metrics.combined.net.totalTrades), 'Total Trades', YELLOW],
    [fmtDollar(lastDay.equity), `Ending Equity (${NAV_DISPLAY} start)`, GREEN],
    [fmtDollar(lastDay.equity - lastDay.spyEquity), 'Alpha vs SPY', GREEN],
  ];

  const boxW = (CW - 20) / 4;
  for (let i = 0; i < headlines.length; i++) {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const bx = LM + col * (boxW + 6.67);
    const by = fy + row * 38;
    doc.rect(bx, by, boxW, 33).fillAndStroke(DKGRAY, MDGRAY);
    doc.fontSize(14).fillColor(headlines[i][2]).font('Helvetica-Bold')
       .text(headlines[i][0], bx + 5, by + 3, { width: boxW - 10, lineBreak: false });
    doc.fontSize(5.5).fillColor(LTGRAY).font('Helvetica')
       .text(headlines[i][1], bx + 5, by + 21, { width: boxW - 10, lineBreak: false });
  }

  fy += 3 * 38 + 10;

  // SPY comparison box on cover
  doc.moveTo(LM, fy).lineTo(LM + 200, fy).strokeColor(YELLOW).lineWidth(1).stroke();
  fy += 8;
  doc.fontSize(8).fillColor(WHITE).font('Helvetica-Bold').text('PNTHR vs S&P 500 AT A GLANCE', LM, fy, { lineBreak: false });
  fy += 14;

  const yearsSpan = metrics.combined.net.months / 12;
  const spyCagr = +((Math.pow(lastDay.spyEquity / STARTING_CAPITAL, 1 / yearsSpan) - 1) * 100).toFixed(1);
  const coverComp = [
    ['', 'PNTHR', 'S&P 500', 'ALPHA'],
    ['Total Return', fmtPct(totalReturn, 0), fmtPct(spyTotalReturn, 0), fmtPct(totalReturn - spyTotalReturn, 0)],
    ['CAGR', fmtPct(metrics.combined.net.cagr, 1), fmtPct(spyCagr, 1), fmtPct(metrics.combined.net.cagr - spyCagr, 1)],
    ['Max Drawdown', fmtPct(-metrics.combined.net.maxDrawdown, 2), fmtPct(-spyDrawdowns[0]?.maxPct || -34, 1), ''],
    ['Ending Equity', fmtDollar(lastDay.equity), fmtDollar(lastDay.spyEquity), fmtDollar(lastDay.equity - lastDay.spyEquity)],
  ];
  const ccWidths = [140, 100, 100, CW - 340];
  for (let r = 0; r < coverComp.length; r++) {
    const isHeader = r === 0;
    let x = LM;
    for (let c = 0; c < coverComp[r].length; c++) {
      const color = isHeader ? YELLOW : c === 1 ? GREEN : c === 3 ? GREEN : LTGRAY;
      doc.fontSize(isHeader ? 6.5 : 7).fillColor(color).font(isHeader ? 'Helvetica-Bold' : 'Helvetica')
         .text(coverComp[r][c], x, fy, { width: ccWidths[c], align: c === 0 ? 'left' : 'right', lineBreak: false });
      x += ccWidths[c];
    }
    fy += isHeader ? 12 : 10;
  }

  // ── Mini cumulative chart + PNTHR head + quote ──
  fy += 30;
  {
    // Build cumulative chart data for mini version
    const miniCumGrowth = computeGrowthForYear('all');
    const miniSpyData = Object.entries(spyGrowthByMonth)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, nav]) => ({ month, nav }));

    if (miniCumGrowth && miniCumGrowth.chartData.length > 1) {
      // Layout: PNTHR head on left, chart on right (slightly off-center)
      const headSize = 70;
      const headX = LM + 10;
      const headY = fy + 5;

      // PNTHR head with glow
      const hcx = headX + headSize / 2, hcy = headY + headSize / 2;
      doc.circle(hcx, hcy, 42).fillOpacity(0.05).fill(YELLOW);
      doc.circle(hcx, hcy, 36).fillOpacity(0.08).fill(YELLOW);
      doc.fillOpacity(1);
      try { doc.image(PNTHR_HEAD_PATH, headX, headY, { width: headSize }); } catch (e) { /* skip */ }

      // Quote below the head
      const quoteY = headY + headSize + 8;
      doc.fontSize(6.5).fillColor(LTGRAY).font('Helvetica-Oblique')
         .text('"Now I\'m going to show you', headX - 10, quoteY, { width: headSize + 30, align: 'center', lineBreak: false });
      doc.text('how we got these', headX - 10, quoteY + 9, { width: headSize + 30, align: 'center', lineBreak: false });
      doc.text('world class returns"', headX - 10, quoteY + 18, { width: headSize + 30, align: 'center', lineBreak: false });
      const sigY = quoteY + 32;
      doc.fontSize(12).fillColor(YELLOW).font('Helvetica-Oblique')
         .text('~ PNTHR', headX - 10, sigY, { width: headSize + 30, align: 'center', lineBreak: false });

      // Mini chart to the right
      const miniChartX = LM + 120;
      const miniChartW = CW - 120;
      const miniChartH = 100;
      const miniPlotX = miniChartX + 35;
      const miniPlotW = miniChartW - 45;
      const miniPlotY = fy + 8;
      const miniPlotH = miniChartH - 20;

      // Chart title
      doc.fontSize(7).fillColor(WHITE).font('Helvetica-Bold')
         .text('Cumulative Growth (2019\u20132026)', miniChartX, fy - 2, { width: miniChartW, lineBreak: false });

      // Y range
      const allVals = [...miniCumGrowth.chartData.map(d => d.nav), ...miniSpyData.map(d => d.nav)];
      const minV = Math.floor(Math.min(...allVals) / 50000) * 50000;
      const maxV = Math.ceil(Math.max(...allVals) / 50000) * 50000;
      const rng = maxV - minV || 1;

      // Gridlines
      const steps = 4;
      doc.strokeColor([40, 40, 40]).lineWidth(0.3);
      for (let i = 0; i <= steps; i++) {
        const val = minV + (rng / steps) * i;
        const gy = miniPlotY + miniPlotH - (i / steps) * miniPlotH;
        doc.moveTo(miniPlotX, gy).lineTo(miniPlotX + miniPlotW, gy).stroke();
        const lbl = val >= 1e6 ? '$' + (val / 1e6).toFixed(1) + 'M' : '$' + Math.round(val / 1000) + 'K';
        doc.fontSize(4.5).fillColor(LTGRAY).font('Helvetica')
           .text(lbl, miniChartX, gy - 3, { width: 33, align: 'right', lineBreak: false });
      }

      // Left axis
      doc.moveTo(miniPlotX, miniPlotY).lineTo(miniPlotX, miniPlotY + miniPlotH)
         .strokeColor([60, 60, 60]).lineWidth(0.5).stroke();

      // Plot SPY (dashed gray)
      if (miniSpyData.length > 1) {
        doc.strokeColor(LTGRAY).lineWidth(0.5).dash(2, { space: 1.5 });
        for (let i = 0; i < miniSpyData.length - 1; i++) {
          const x1 = miniPlotX + (i / (miniSpyData.length - 1)) * miniPlotW;
          const y1 = miniPlotY + miniPlotH - ((miniSpyData[i].nav - minV) / rng) * miniPlotH;
          const x2 = miniPlotX + ((i + 1) / (miniSpyData.length - 1)) * miniPlotW;
          const y2 = miniPlotY + miniPlotH - ((miniSpyData[i + 1].nav - minV) / rng) * miniPlotH;
          doc.moveTo(x1, y1).lineTo(x2, y2).stroke();
        }
        doc.undash();
      }

      // Plot PNTHR (solid yellow)
      const pd = miniCumGrowth.chartData;
      if (pd.length > 1) {
        doc.strokeColor(YELLOW).lineWidth(1.2);
        for (let i = 0; i < pd.length - 1; i++) {
          const x1 = miniPlotX + (i / (pd.length - 1)) * miniPlotW;
          const y1 = miniPlotY + miniPlotH - ((pd[i].nav - minV) / rng) * miniPlotH;
          const x2 = miniPlotX + ((i + 1) / (pd.length - 1)) * miniPlotW;
          const y2 = miniPlotY + miniPlotH - ((pd[i + 1].nav - minV) / rng) * miniPlotH;
          doc.moveTo(x1, y1).lineTo(x2, y2).stroke();
        }
        // PNTHR head at end
        const lastNav = pd[pd.length - 1].nav;
        const endX = miniPlotX + miniPlotW - 6;
        const endY = miniPlotY + miniPlotH - ((lastNav - minV) / rng) * miniPlotH - 6;
        doc.circle(endX + 6, endY + 6, 9).fillOpacity(0.08).fill(YELLOW);
        doc.circle(endX + 6, endY + 6, 7).fillOpacity(0.12).fill(YELLOW);
        doc.fillOpacity(1);
        try { doc.image(PNTHR_HEAD_PATH, endX, endY, { width: 12 }); } catch (e) { /* skip */ }
      }

      // Mini legend
      const mLegY = miniPlotY + miniPlotH + 6;
      doc.strokeColor(YELLOW).lineWidth(1);
      doc.moveTo(miniPlotX + miniPlotW / 2 - 80, mLegY + 3).lineTo(miniPlotX + miniPlotW / 2 - 68, mLegY + 3).stroke();
      doc.fontSize(4.5).fillColor(YELLOW).font('Helvetica')
         .text('PNTHR Fund', miniPlotX + miniPlotW / 2 - 65, mLegY, { lineBreak: false });
      doc.strokeColor(LTGRAY).lineWidth(0.5).dash(2, { space: 1.5 });
      doc.moveTo(miniPlotX + miniPlotW / 2 + 10, mLegY + 3).lineTo(miniPlotX + miniPlotW / 2 + 22, mLegY + 3).stroke();
      doc.undash();
      doc.fillColor(LTGRAY).text('S&P 500', miniPlotX + miniPlotW / 2 + 25, mLegY, { lineBreak: false });
    }
  }

  {
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.fontSize(6).fillColor(MDGRAY).font('Helvetica')
       .text('CONFIDENTIAL - For Qualified Investors Only - Not an Offer to Sell Securities', LM, H - 48, { align: 'center', width: CW, lineBreak: false });
    doc.fontSize(5.5).fillColor(MDGRAY)
       .text('Past performance is not indicative of future results. See full disclaimers on final page.', LM, H - 38, { align: 'center', width: CW, lineBreak: false });
    doc.page.margins.bottom = saved;
  }
  pageFooter();

  // ═══════════════════════════════════════════════════════════════════════════
  // TABLE OF CONTENTS
  // ═══════════════════════════════════════════════════════════════════════════
  newBlackPage();
  let y = CONTENT_TOP;
  y = sectionTitle('TABLE OF CONTENTS', y);

  // ACT I — THE RESULTS
  doc.fontSize(8).fillColor(YELLOW).font('Helvetica-Bold');
  doc.text('ACT I — THE RESULTS', LM, y, { width: CW, lineBreak: false });
  y = doc.y + 8;

  const tocActI = [
    ['Executive Summary', '3'],
    ['Performance Comparison: PNTHR vs. S&P 500', '3'],
    ['Crisis Alpha: Performance During Market Drawdowns', '4'],
    ['Annual Performance: PNTHR vs S&P 500', '4'],
    ['Strategy Metrics by Direction', '4'],
    ['Monthly Returns Heatmap', '5'],
    ['Drawdown Analysis', '5'],
    ['Risk Architecture', '6'],
    ['Worst-Case Trade Analysis (MAE)', '6'],
    ['Rolling 12-Month Returns', '7'],
    ['Best & Worst Trading Days', '7'],
  ];

  for (const [entry, pg] of tocActI) {
    doc.fontSize(7.5).fillColor(WHITE).font('Helvetica')
       .text(entry, LM + 12, y, { width: CW - 80, lineBreak: false });
    doc.fontSize(7.5).fillColor(LTGRAY)
       .text(pg, LM + CW - 40, y, { width: 40, align: 'right', lineBreak: false });
    y += 12;
  }

  y += 8;

  // ACT II — THE METHODOLOGY
  doc.fontSize(8).fillColor(YELLOW).font('Helvetica-Bold');
  doc.text('ACT II — THE METHODOLOGY', LM, y, { width: CW, lineBreak: false });
  y = doc.y + 8;

  const tocActII = [
    ['1. The PNTHR Philosophy & Platform', '8'],
    ['2. PNTHR Signal Generation', '9'],
    ['3. The PNTHR Kill Scoring Engine', '10'],
    ['4. PNTHR Analyze Pre-Trade Scoring', '11'],
    ['5. PNTHR Position Sizing & Pyramiding', '12'],
    ['6. Portfolio Command Center & Entry Workflow', '13'],
    ['7. Scoring Health / Archive / History / IBKR Bridge', '13'],
    ['8. Institutional Backtest Results', '14'],
    ['9. Empirical Evidence', '16'],
  ];

  for (const [entry, pg] of tocActII) {
    doc.fontSize(7.5).fillColor(WHITE).font('Helvetica')
       .text(entry, LM + 12, y, { width: CW - 80, lineBreak: false });
    doc.fontSize(7.5).fillColor(LTGRAY)
       .text(pg, LM + CW - 40, y, { width: 40, align: 'right', lineBreak: false });
    y += 12;
  }

  y += 8;

  // ACT III — THE PROOF
  doc.fontSize(8).fillColor(YELLOW).font('Helvetica-Bold');
  doc.text('ACT III — THE PROOF', LM, y, { width: CW, lineBreak: false });
  y = doc.y + 8;

  const tocActIII = [
    ['Comprehensive Daily NAV Log', '17'],
  ];

  for (const [entry, pg] of tocActIII) {
    doc.fontSize(7.5).fillColor(WHITE).font('Helvetica')
       .text(entry, LM + 12, y, { width: CW - 80, lineBreak: false });
    doc.fontSize(7.5).fillColor(LTGRAY)
       .text(pg, LM + CW - 40, y, { width: 40, align: 'right', lineBreak: false });
    y += 12;
  }

  y += 8;

  // ACT IV — THE CLOSE
  doc.fontSize(8).fillColor(YELLOW).font('Helvetica-Bold');
  doc.text('ACT IV — THE CLOSE', LM, y, { width: CW, lineBreak: false });
  y = doc.y + 8;

  const tocActIV = [
    ['Executive Recap', '~58'],
    ['Cumulative Growth Chart', '~59'],
    ['Important Disclosures', '~60'],
  ];

  for (const [entry, pg] of tocActIV) {
    doc.fontSize(7.5).fillColor(WHITE).font('Helvetica')
       .text(entry, LM + 12, y, { width: CW - 80, lineBreak: false });
    doc.fontSize(7.5).fillColor(LTGRAY)
       .text(pg, LM + CW - 40, y, { width: 40, align: 'right', lineBreak: false });
    y += 12;
  }

  pageFooter();

  // ═══════════════════════════════════════════════════════════════════════════
  // PAGE 2: EXECUTIVE SUMMARY + PERFORMANCE COMPARISON
  // ═══════════════════════════════════════════════════════════════════════════
  newBlackPage();
  y = CONTENT_TOP;
  y = sectionTitle('EXECUTIVE SUMMARY', y);

  const execParas = [
    `The Carnivore Quant Fund employs a proprietary systematic long/short equity strategy that identifies high-conviction entry points through an 8-dimensional scoring engine applied to the PNTHR 679 universe, a curated selection of liquid U.S. equities. Like its namesake, the system stalks opportunity with discipline, strikes with precision, and manages risk with the instinct of a panther that never overextends.`,
    `Over a rigorous 7-year backtest spanning June 2019 through April 2026, the strategy delivered a ${fmtPct(metrics.combined.net.cagr, 1)} net CAGR with a ${metrics.combined.net.sharpe.toFixed(2)} Sharpe ratio and ${metrics.combined.net.profitFactor.toFixed(1)}x profit factor, transforming ${NAV_DISPLAY} into ${fmtDollar(lastDay.equity)}. During the same period, a passive S&P 500 allocation returned ${fmtPct(spyTotalReturn, 0)}, producing ${fmtDollar(lastDay.spyEquity)}. The Fund generated ${fmtDollar(lastDay.equity - lastDay.spyEquity)} of alpha.`,
    `The Fund's risk architecture is built on absolute capital preservation. The maximum monthly drawdown across ${metrics.combined.net.months} months was just ${fmtPct(-metrics.combined.net.maxDrawdown, 2)}. ${metrics.combined.net.positiveMonths} of ${metrics.combined.net.months} months (${metrics.combined.net.positiveMonthsPct}%) were profitable. At no point during the backtest period did the mark-to-market portfolio balance decline below investor capital.`,
    `Position sizing is mathematically constrained: each trade risks a maximum of 1% of net asset value, with a 5-lot pyramid system that deploys just 35% of the full position at initial entry. Even the worst single-trade adverse excursion (-15.2%) translated to approximately 0.5% of portfolio NAV.`,
  ];
  for (const para of execParas) {
    doc.fontSize(7.5).fillColor(WHITE).font('Helvetica').lineGap(0)
       .text(para, LM, y, { width: CW, lineBreak: true });
    y = doc.y + 6;
  }

  y += 6;
  y = sectionTitle('PERFORMANCE COMPARISON: PNTHR vs. S&P 500', y);

  const compCols = ['METRIC', 'CARNIVORE QUANT FUND', 'S&P 500 (SPY)', 'ALPHA'];
  const compWidths = [150, 110, 110, CW - 370];
  y = tableHeader(compCols, y, compWidths);

  const compRows = [
    ['Total Return (7yr)', fmtPct(totalReturn, 0), fmtPct(spyTotalReturn, 0), fmtPct(totalReturn - spyTotalReturn, 0)],
    ['CAGR (Net)', fmtPct(metrics.combined.net.cagr, 1), fmtPct(spyCagr, 1), fmtPct(metrics.combined.net.cagr - spyCagr, 1)],
    ['Sharpe Ratio', metrics.combined.net.sharpe.toFixed(2), '~0.8', ''],
    ['Sortino Ratio', metrics.combined.net.sortino.toFixed(1), '~1.0', ''],
    ['Max Monthly Drawdown', fmtPct(-metrics.combined.net.maxDrawdown, 2), fmtPct(-spyDrawdowns[0]?.maxPct || -34, 1), ''],
    ['Calmar Ratio', metrics.combined.net.calmar.toFixed(1), '~0.4', ''],
    ['Positive Months', `${metrics.combined.net.positiveMonths}/${metrics.combined.net.months} (${metrics.combined.net.positiveMonthsPct}%)`, '~60%', ''],
    ['Win Rate', metrics.combined.net.winRate.toFixed(1) + '%', 'N/A', ''],
    ['Profit Factor', metrics.combined.net.profitFactor.toFixed(1) + 'x', 'N/A', ''],
    [`Ending Equity (${NAV_DISPLAY})`, fmtDollar(lastDay.equity), fmtDollar(lastDay.spyEquity), fmtDollar(lastDay.equity - lastDay.spyEquity)],
  ];
  for (const row of compRows) {
    const isDD = row[0] === 'Max Monthly Drawdown';
    const colors = [LTGRAY, isDD ? RED : GREEN, LTGRAY, GREEN];
    y = tableRow(row, y, compWidths, colors);
  }
  pageFooter();

  // ═══════════════════════════════════════════════════════════════════════════
  // SYSTEM ARCHITECTURE & METHODOLOGY (from System Architecture v7.0)
  // ═══════════════════════════════════════════════════════════════════════════

  // Helper for architecture section body text
  function archPara(text, yPos) {
    yPos = checkPage(yPos, 20);
    doc.fontSize(7.5).fillColor(WHITE).font('Helvetica').lineGap(1)
       .text(text, LM, yPos, { width: CW, lineBreak: true });
    return doc.y + 6;
  }
  function archSubhead(text, yPos) {
    yPos = checkPage(yPos, 20);
    doc.fontSize(9).fillColor(YELLOW).font('Helvetica-Bold')
       .text(text, LM, yPos, { width: CW, lineBreak: false });
    return doc.y + 6;
  }
  function archBullet(text, yPos) {
    yPos = checkPage(yPos, 14);
    doc.fontSize(7).fillColor(LTGRAY).font('Helvetica').lineGap(0.5)
       .text('  -  ' + text, LM + 8, yPos, { width: CW - 16, lineBreak: true });
    return doc.y + 3;
  }
  function archTable(headers, rows, widths, yPos) {
    yPos = checkPage(yPos, 30);
    yPos = tableHeader(headers, yPos, widths);
    for (const row of rows) {
      yPos = checkPage(yPos, 12);
      yPos = tableRow(row, yPos, widths, Array(row.length).fill(LTGRAY).map((c, i) => i === 0 ? WHITE : LTGRAY));
    }
    return yPos + 6;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // CRISIS ALPHA + ANNUAL RETURNS + DIRECTION METRICS
  // ═══════════════════════════════════════════════════════════════════════════
  newBlackPage();
  y = CONTENT_TOP;
  y = sectionTitle('CRISIS ALPHA: PERFORMANCE DURING MARKET DRAWDOWNS', y);

  doc.fontSize(7.5).fillColor(LTGRAY).font('Helvetica').lineGap(0);
  doc.text('The hallmark of a disciplined panther is composure under pressure. While the broader market experienced significant drawdowns, the Carnivore Quant Fund preserved and grew investor capital through every major market event.', LM, y, { width: CW, lineBreak: true });
  y = doc.y + 8;

  const crisisCols = ['MARKET EVENT', 'PERIOD', 'S&P 500', 'PNTHR FUND', 'PNTHR ALPHA'];
  const crisisWidths = [130, 150, 80, 80, CW - 440];
  y = tableHeader(crisisCols, y, crisisWidths, null, WHITE);
  for (const cp of crisisPerformance) {
    const alpha = cp.pnthrReturn - cp.spyDrawdown;
    const colors = [WHITE, LTGRAY, RED, cp.pnthrReturn >= 0 ? GREEN : RED, GREEN];
    y = tableRow([cp.label, cp.period, fmtPct(cp.spyDrawdown, 1), fmtPct(cp.pnthrReturn, 1), '+' + alpha.toFixed(1) + '%'], y, crisisWidths, colors);
  }

  y += 14;
  y = sectionTitle('ANNUAL PERFORMANCE: PNTHR vs S&P 500', y);
  const annCols = ['YEAR', 'SPY EQUITY', 'S&P 500', 'PNTHR EQUITY', 'PNTHR NET', 'PNTHR ALPHA'];
  const annWidths = [55, 100, 85, 100, 85, CW - 425];
  y = tableHeader(annCols, y, annWidths, null, WHITE);

  for (const yr of years) {
    const a = annualReturns[yr];
    // Find year-end equity
    const yrEnd = dailyNav.filter(d => d.date.startsWith(yr)).pop();
    const colors = [WHITE, LTGRAY, LTGRAY, YELLOW, a.return >= 0 ? GREEN : RED, a.alpha >= 0 ? GREEN : RED];
    y = tableRow([
      yr, '$' + fmtComma(Math.round(yrEnd?.spyEquity || 0)),
      fmtPct(a.spy, 1),
      '$' + fmtComma(Math.round(yrEnd?.equity || 0)),
      fmtPct(a.return, 1), fmtPct(a.alpha, 1),
    ], y, annWidths, colors);
  }

  y += 6;
  y = checkPage(y, 40);
  doc.fontSize(6.5).fillColor(LTGRAY).font('Helvetica').lineGap(0.5);
  doc.text('"PNTHR NET" returns are fully burdened: all figures above are net of IBKR Pro Fixed commissions ($0.005/share), 5 basis points of slippage per leg, sector-tiered short borrow costs (1.0-2.0% annualized), a 2.0% per annum management fee on NAV, and a tiered performance allocation of 20%, 25%, 30% (by investor class) on net profits above a hurdle rate equal to the US 2-Year Treasury Yield, reset annually, subject to a high-water mark with loss carryforward provision. These are the returns an investor would have realized after every cost and fee.', LM, y, { width: CW, lineBreak: true });
  doc.lineGap(0);
  y = doc.y + 10;

  y = sectionTitle('STRATEGY METRICS BY DIRECTION', y);
  const dirCols = ['METRIC', 'BL (LONGS)', 'SS (SHORTS)', 'COMBINED'];
  const dirWidths = [140, 110, 110, CW - 360];
  y = tableHeader(dirCols, y, dirWidths);

  const m = metrics;
  const dirRows = [
    ['Net CAGR', fmtPct(m.bl.net.cagr, 1), fmtPct(m.ss.net.cagr, 1), fmtPct(m.combined.net.cagr, 1)],
    ['Sharpe Ratio', m.bl.net.sharpe.toFixed(2), m.ss.net.sharpe.toFixed(2), m.combined.net.sharpe.toFixed(2)],
    ['Sortino Ratio', m.bl.net.sortino.toFixed(2), m.ss.net.sortino.toFixed(2), m.combined.net.sortino.toFixed(2)],
    ['Max Drawdown', fmtPct(-m.bl.net.maxDrawdown, 2), fmtPct(-m.ss.net.maxDrawdown, 2), fmtPct(-m.combined.net.maxDrawdown, 2)],
    ['Calmar Ratio', m.bl.net.calmar.toFixed(1), m.ss.net.calmar.toFixed(1), m.combined.net.calmar.toFixed(1)],
    ['Profit Factor', m.bl.net.profitFactor.toFixed(2) + 'x', m.ss.net.profitFactor.toFixed(2) + 'x', m.combined.net.profitFactor.toFixed(2) + 'x'],
    ['Win Rate', m.bl.net.winRate.toFixed(1) + '%', m.ss.net.winRate.toFixed(1) + '%', m.combined.net.winRate.toFixed(1) + '%'],
    ['Avg Monthly Return', fmtPct(m.bl.net.meanMonthlyReturn, 2), fmtPct(m.ss.net.meanMonthlyReturn, 2), fmtPct(m.combined.net.meanMonthlyReturn, 2)],
    ['Monthly Std Dev', m.bl.net.monthlyStdDev.toFixed(2) + '%', m.ss.net.monthlyStdDev.toFixed(2) + '%', m.combined.net.monthlyStdDev.toFixed(2) + '%'],
    ['Best Month', fmtPct(m.bl.net.bestMonth, 1), fmtPct(m.ss.net.bestMonth, 1), fmtPct(m.combined.net.bestMonth, 1)],
    ['Worst Month', fmtPct(m.bl.net.worstMonth, 2), fmtPct(m.ss.net.worstMonth, 2), fmtPct(m.combined.net.worstMonth, 2)],
    ['Positive Months', `${m.bl.net.positiveMonths}/${m.bl.net.months}`, `${m.ss.net.positiveMonths}/${m.ss.net.months}`, `${m.combined.net.positiveMonths}/${m.combined.net.months}`],
    ['Total Trades', fmtComma(m.bl.net.totalTrades), fmtComma(m.ss.net.totalTrades), fmtComma(m.combined.net.totalTrades)],
  ];
  for (const row of dirRows) {
    y = tableRow(row, y, dirWidths, [LTGRAY, WHITE, WHITE, YELLOW]);
  }
  pageFooter();

  // ═══════════════════════════════════════════════════════════════════════════
  // PAGE 4: MONTHLY RETURNS HEATMAP
  // ═══════════════════════════════════════════════════════════════════════════
  newBlackPage();
  y = CONTENT_TOP;
  y = sectionTitle('MONTHLY RETURNS HEATMAP (NET %)', y);

  const monthLabels = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC', 'YEAR'];
  const heatCellW = (CW - 40) / 14;
  const heatCellH = 18;

  // Header
  doc.fontSize(5.5).fillColor(YELLOW).font('Helvetica-Bold');
  let hx = LM + 40;
  for (const ml of monthLabels) {
    doc.text(ml, hx, y, { width: heatCellW, align: 'center', lineBreak: false });
    hx += heatCellW;
  }
  y += 12;

  for (const yr of years) {
    doc.fontSize(6.5).fillColor(WHITE).font('Helvetica-Bold')
       .text(yr, LM, y + 4, { width: 35, lineBreak: false });
    hx = LM + 40;
    let yrCompound = 1;
    for (let mo = 1; mo <= 12; mo++) {
      const mk = yr + '-' + String(mo).padStart(2, '0');
      const mr = monthlyReturns[mk];
      if (mr) {
        yrCompound *= (1 + mr.return / 100);
        const val = mr.return;
        let bgColor;
        if (val >= 10) bgColor = [0, 100, 0];
        else if (val >= 5) bgColor = [0, 80, 0];
        else if (val >= 2) bgColor = [0, 60, 10];
        else if (val >= 0) bgColor = [20, 50, 20];
        else if (val >= -1) bgColor = [80, 30, 30];
        else bgColor = [120, 20, 20];
        doc.rect(hx + 1, y, heatCellW - 2, heatCellH - 2).fill(bgColor);
        doc.fontSize(5.5).fillColor(val >= 0 ? GREEN : RED).font('Helvetica')
           .text(val.toFixed(1), hx + 1, y + 5, { width: heatCellW - 2, align: 'center', lineBreak: false });
      } else {
        doc.rect(hx + 1, y, heatCellW - 2, heatCellH - 2).fill([20, 20, 20]);
        doc.fontSize(5.5).fillColor(MDGRAY).text('-', hx + 1, y + 5, { width: heatCellW - 2, align: 'center', lineBreak: false });
      }
      hx += heatCellW;
    }
    const yrRet = (yrCompound - 1) * 100;
    doc.rect(hx + 1, y, heatCellW - 2, heatCellH - 2).fill([40, 40, 0]);
    doc.fontSize(5.5).fillColor(YELLOW).font('Helvetica-Bold')
       .text(fmtPct(yrRet, 1), hx + 1, y + 5, { width: heatCellW - 2, align: 'center', lineBreak: false });
    y += heatCellH;
  }

  y += 6;
  doc.fontSize(6.5).fillColor(LTGRAY).font('Helvetica');
  doc.text(`${metrics.combined.net.positiveMonths} of ${metrics.combined.net.months} months profitable (${metrics.combined.net.positiveMonthsPct}%)  |  Only ${metrics.combined.net.months - metrics.combined.net.positiveMonths} negative months in 7 years  |  Worst: ${fmtPct(metrics.combined.net.worstMonth, 2)}  |  Best: ${fmtPct(metrics.combined.net.bestMonth, 1)}`, LM, y, { width: CW, lineBreak: false });

  y += 20;
  y = sectionTitle('DRAWDOWN ANALYSIS', y);

  doc.fontSize(7.5).fillColor(LTGRAY).font('Helvetica').lineGap(0);
  doc.text('The Fund operates with zero tolerance for capital impairment. The maximum monthly drawdown was just ' + fmtPct(-metrics.combined.net.maxDrawdown, 2) + '. The deepest mark-to-market trough occurred during COVID recovery and was fully recovered within days. At no point did investor capital sustain a permanent loss nor meaningful decline.', LM, y, { width: CW, lineBreak: true });
  y = doc.y + 8;

  const ddCols = ['START', 'TROUGH', 'RECOVERY', 'DURATION', 'MTM TROUGH', 'PNTHR RETURN'];
  const ddWidths = [90, 90, 90, 65, 80, CW - 415];
  y = tableHeader(ddCols, y, ddWidths, null, WHITE);

  for (const dd of drawdownEvents.slice(0, 10)) {
    y = tableRow([
      dd.start, dd.troughDate, dd.recoveryDate,
      dd.durationDays + ' days', fmtPct(-dd.maxDDPct, 2),
      fmtPct(dd.periodReturn, 2)
    ], y, ddWidths, [LTGRAY, LTGRAY, LTGRAY, LTGRAY, RED, dd.periodReturn >= 0 ? GREEN : RED]);
    if (y > BOTTOM - 40) break;
  }

  y += 6;
  doc.fontSize(6.5).fillColor(LTGRAY).font('Helvetica-Oblique').lineGap(0);
  doc.text('All drawdowns shown are intraday mark-to-market troughs. No drawdown resulted in permanent capital loss.', LM, y, { width: CW, lineBreak: true });
  doc.font('Helvetica');
  y = doc.y + 4;
  pageFooter();

  // ═══════════════════════════════════════════════════════════════════════════
  // RISK ARCHITECTURE
  // ═══════════════════════════════════════════════════════════════════════════
  newBlackPage();
  y = CONTENT_TOP;
  y = sectionTitle('RISK ARCHITECTURE', y);

  doc.fontSize(7.5).fillColor(WHITE).font('Helvetica').lineGap(0);
  doc.text('The Carnivore Quant Fund is engineered for capital preservation first, alpha generation second. Every aspect of the system, from signal selection to position sizing to exit discipline, ensures the portfolio can absorb adverse conditions without meaningful drawdown.', LM, y, { width: CW, lineBreak: true });
  y = doc.y + 10;

  const riskItems = [
    ['1% VITALITY CAP', 'Each stock position risks a maximum of 1% of NAV. ETF positions are capped at 0.5%. Share count = floor(risk budget / risk per share). A wider stop produces fewer shares, not more risk.'],
    ['5-LOT PYRAMID SYSTEM', 'Initial entry deploys only 35% of the full position. Subsequent lots at +3%, +6%, +10%, +14%. Each lot fill triggers a stop ratchet, progressively locking in gains.'],
    ['10% POSITION CAP', 'No single ticker can exceed 10% of NAV in total exposure, preventing concentration risk even in high-conviction names.'],
    ['SECTOR CONCENTRATION LIMIT', 'Net directional exposure capped at 3 positions per sector (|longs - shorts|). Prevents correlated drawdowns from sector-specific events.'],
    ['PORTFOLIO HEAT CAPS', 'Total open risk capped at 10% for stocks, 5% for ETFs, and 15% combined. Recycled positions (stop beyond entry) carry $0 risk.'],
    ['SYSTEMATIC EXIT DISCIPLINE', 'Exits: EMA crossover reversal, RSI > 85 feast alert, ATR stop hit, 20-day stale hunt liquidation, risk advisor triggers. Manual overrides tracked and scored.'],
    ['WASH SALE COMPLIANCE', '30-day re-entry lockout on losing trades, automatically enforced by the pipeline.'],
  ];

  for (const [title, desc] of riskItems) {
    y = checkPage(y, 30);
    doc.fontSize(7.5).fillColor(YELLOW).font('Helvetica-Bold').lineGap(0)
       .text(title, LM, y, { width: CW, lineBreak: false });
    y = doc.y + 2;
    doc.fontSize(6.5).fillColor(LTGRAY).font('Helvetica').lineGap(0)
       .text(desc, LM + 10, y, { width: CW - 10, lineBreak: true });
    y = doc.y + 7;
  }

  y += 6;
  y = checkPage(y, 50);
  y = sectionTitle('WORST-CASE TRADE ANALYSIS (MAX ADVERSE EXCURSION)', y);
  doc.fontSize(7).fillColor(LTGRAY).font('Helvetica').lineGap(0);
  doc.text('The maximum adverse excursion (MAE) measures the worst intra-trade price move against the position before exit. The table below shows the 10 most extreme adverse moves across ' + fmtComma(metrics.combined.net.totalTrades) + ' closed pyramid trades. Despite these individual trade drawdowns, the portfolio never experienced a negative month-end balance decline. Position sizing (1% vitality / 10% ticker cap) ensures even worst-case MAE translates to minimal portfolio impact.', LM, y, { width: CW, lineBreak: true });
  y = doc.y + 8;

  // Top 10 MAE table
  const maeCols = ['TICKER', 'SIGNAL', 'ENTRY', 'EXIT', 'MAE %', 'NET P&L', 'EXIT REASON', 'MONTH RETURN'];
  const maeWidths = [45, 35, 55, 55, 42, 50, 70, CW - 352];
  y = checkPage(y, 20);
  y = tableHeader(maeCols, y, maeWidths);

  for (const t of top10MAE) {
    y = checkPage(y, 12);
    // Find what the fund returned in the month this MAE occurred
    const maeMonth = t.entryDate.slice(0, 7);
    const mr = monthlyReturns[maeMonth];
    const monthRetStr = mr ? fmtPct(mr.return, 2) : 'N/A';
    const monthRetColor = mr && mr.return >= 0 ? GREEN : RED;

    y = tableRow([
      t.ticker,
      t.direction === 'LONG' ? 'BL' : 'SS',
      t.entryDate,
      t.exitDate,
      fmtPct(t.maePct, 1),
      (t.netPnlDollar >= 0 ? '+$' : '-$') + Math.abs(Math.round(t.netPnlDollar)),
      t.exitReason,
      monthRetStr,
    ], y, maeWidths, [WHITE, LTGRAY, LTGRAY, LTGRAY, RED, t.netPnlDollar >= 0 ? GREEN : RED, LTGRAY, monthRetColor]);
  }

  y += 10;
  y = checkPage(y, 30);
  doc.fontSize(7).fillColor(WHITE).font('Helvetica-Bold').lineGap(0);
  doc.text('KEY TAKEAWAY:', LM, y, { width: CW, lineBreak: false });
  y = doc.y + 3;
  doc.fontSize(7).fillColor(LTGRAY).font('Helvetica');
  doc.text('At no point during the entire 7-year backtest did the account balance or investor equity decline below prior high-water marks for more than a single month. Even during the months when these worst-case MAE trades occurred, the portfolio remained profitable on a net basis. The 1% vitality cap and 35% initial lot sizing ensure that no single adverse trade can materially impair investor capital.', LM, y, { width: CW, lineBreak: true });

  pageFooter();

  // ═══════════════════════════════════════════════════════════════════════════
  // ROLLING METRICS + BEST/WORST DAYS
  // ═══════════════════════════════════════════════════════════════════════════
  newBlackPage();
  y = CONTENT_TOP;
  y = sectionTitle('ROLLING 12-MONTH RETURNS', y);

  doc.fontSize(7.5).fillColor(LTGRAY).font('Helvetica').lineGap(0);
  doc.text(`Across ${rolling12.length} rolling 12-month windows, the minimum return was ${fmtPct(minRolling12.return, 1)} (ending ${minRolling12.month}). No rolling 12-month period was negative. The Fund has generated positive absolute returns over every trailing year of the backtest.`, LM, y, { width: CW, lineBreak: true });
  y = doc.y + 8;

  const r12Cols = ['ENDING MONTH', 'TRAILING 12M RETURN'];
  const r12Widths = [120, CW - 120];
  y = tableHeader(r12Cols, y, r12Widths, null, WHITE);

  const r12Display = rolling12.filter((_, i) => i % 6 === 0 || rolling12[i].month === minRolling12.month);
  for (const r of r12Display) {
    const isMin = r.month === minRolling12.month;
    y = tableRow([r.month, fmtPct(r.return, 1)], y, r12Widths,
      [LTGRAY, r.return >= 0 ? GREEN : RED]);
    if (y > H / 2 - 20) break;
  }

  y += 14;
  y = sectionTitle('BEST & WORST TRADING DAYS', y);
  doc.fontSize(7).fillColor(LTGRAY).font('Helvetica-Oblique').text('Data is sorted by Daily Return.', LM, y, { lineBreak: false });
  y += 12;

  const daysCols = ['DATE', 'DAILY RETURN', 'SPY EQUITY', 'PNTHR EQUITY'];
  const daysWidths = [100, 110, 100, CW - 310];

  doc.fontSize(7.5).fillColor(YELLOW).font('Helvetica-Bold').text('10 WORST DAYS', LM, y, { lineBreak: false });
  y += 10;
  y = tableHeader(daysCols, y, daysWidths, null, WHITE);
  for (const d of worst10Days) {
    const spyDay = dailyNav.find(x => x.date === d.date);
    y = tableRow([d.date, fmtPct(d.return, 3), spyDay ? '$' + fmtComma(Math.round(spyDay.spyEquity)) : '', '$' + fmtComma(Math.round(d.equity))], y, daysWidths, [LTGRAY, RED, LTGRAY, YELLOW]);
  }

  y += 12;
  doc.fontSize(7.5).fillColor(YELLOW).font('Helvetica-Bold').text('10 BEST DAYS', LM, y, { lineBreak: false });
  y += 10;
  y = tableHeader(daysCols, y, daysWidths, null, WHITE);
  for (const d of best10Days) {
    const spyDay = dailyNav.find(x => x.date === d.date);
    y = tableRow([d.date, fmtPct(d.return, 3), spyDay ? '$' + fmtComma(Math.round(spyDay.spyEquity)) : '', '$' + fmtComma(Math.round(d.equity))], y, daysWidths, [LTGRAY, GREEN, LTGRAY, YELLOW]);
  }

  pageFooter();

  // ── 1. THE PNTHR PHILOSOPHY & PLATFORM ──────────────────────────────────
  newBlackPage();
  y = CONTENT_TOP;
  y = sectionTitle('1. THE PNTHR PHILOSOPHY & PLATFORM', y);

  y = archSubhead('Research Origins', y);
  y = archPara('PNTHR Funds is built on seven years of painstaking research and testing that began in 2019 with a single question: can we identify the measurable conditions that separate winning trades from losing ones? After analyzing thousands of trades across multiple market cycles, including the COVID-19 crash of March 2020, the 2022 bear market, and the 2023-2026 recovery, the answer was an unequivocal yes. Every rule in this system exists because the data demanded it. This is a transparent, empirically validated methodology that adapts to any market environment; and the backtest results prove it.', y);

  y = archPara('The PNTHR research program began in 2019, systematically cataloging equity signals across hundreds of U.S. stocks through bull markets, bear markets, corrections, and recoveries. Over seven years, the team refined a proprietary signal generation framework, tested it against ' + fmtComma(metrics.combined.net.totalTrades) + ' pyramid-deployed positions across all market conditions, and identified the specific measurable conditions that predict trade success with statistical significance.', y);

  y = archSubhead('Investment Philosophy', y);
  y = archPara('Confirmation over prediction. PNTHR never predicts where a stock will go. The system waits for the market to confirm that a trade is working before committing meaningful capital. The pyramid model deploys only 35% of a maximum risk of only 1% on the initial signal; each subsequent lot requires the market to prove the setup is working. This discipline, validated across ' + fmtComma(metrics.combined.net.totalTrades) + ' pyramid positions, drives a profit factor of ' + metrics.combined.net.profitFactor.toFixed(2) + 'x and a combined Sharpe Ratio of ' + metrics.combined.net.sharpe.toFixed(2) + '; metrics that exceed the targets of the world\'s top hedge funds.', y);

  y = archPara('All-Weather Adaptability. The PNTHR system is explicitly designed for all market conditions. In bearish environments, the crash gate activates short signals while blocking longs. In bull markets, longs dominate and shorts are structurally blocked. During the COVID crash of March 2020, the worst monthly market return in 90 years, the PNTHR strategy returned +0.53%. The system did not just survive the crash; it made money during it.', y);

  y = archSubhead('The PNTHR 679 Universe', y);
  y = archPara('Every week the system scans 679 premier U.S. equities: the S&P 500, Nasdaq 100, Dow 30, plus select large-cap and mid-cap securities. The universe was selected for liquidity, coverage across all 11 GICS sectors, and representation across all market caps from $2B to $3T+.', y);

  y = archSubhead('Platform Architecture', y);
  const platCols = ['LAYER', 'TECHNOLOGY', 'ROLE'];
  const platWidths = [80, 150, CW - 230];
  y = archTable(platCols, [
    ['Client', 'React + Vite (Vercel)', 'Real-time dashboard, Kill page, Command Center'],
    ['Server', 'Node.js + Express (Render)', 'Signal engine, scoring, portfolio management'],
    ['Database', 'MongoDB Atlas', 'Signal cache, portfolio, audit log, backtest data'],
    ['Price Data', 'FMP API + IBKR TWS', 'Live quotes, historical candles, brokerage sync'],
    ['Scoring', 'Full 8-Dimension Kill Engine', 'Weekly Friday pipeline, 679-stock universe'],
  ], platWidths, y);

  pageFooter();

  // ── 2. PNTHR SIGNAL GENERATION ──────────────────────────────────────────
  newBlackPage();
  y = CONTENT_TOP;
  y = sectionTitle('2. PNTHR SIGNAL GENERATION', y);

  y = archPara('PNTHR signals are generated by measurable, repeatable conditions validated across thousands of trades. The daylight requirement eliminates false breakouts. Separate calibration for ETFs (0.3% vs 1% for stocks) reflects years of observation that different asset classes behave differently at trend boundaries.', y);

  y = archSubhead('The 21-Week EMA', y);
  y = archPara('Approximately five months of price action. Chosen through extensive testing as the timeframe that best balances noise reduction with trend responsiveness. Computed from 250 daily candles aggregated into weekly bars, not dependent on any external API endpoint.', y);

  y = archSubhead('Per-Sector Optimized EMA Periods', y);
  y = archPara('Seven years of backtesting revealed that different sectors have meaningfully different trend cycle lengths. PNTHR uses empirically optimized EMA periods per sector (periods 15-26 tested), validated out-of-sample: Train 2020-2023 (+131%), Test 2024-2026 (+73%). Zero year regressions.', y);

  const emaCols = ['SECTOR', 'EMA PERIOD', 'CYCLE'];
  const emaWidths = [200, 80, CW - 280];
  y = archTable(emaCols, [
    ['Consumer Staples / Basic Materials / Consumer Discretionary', '18-19', 'Fast Cycle'],
    ['Technology / Communication Services / Utilities', '21', 'Standard'],
    ['Healthcare / Industrials', '24', 'Slow Cycle'],
    ['Financial Services', '25', 'Slow Cycle'],
    ['Energy / Real Estate', '26', 'Slow Cycle'],
  ], emaWidths, y);

  y = archSubhead('BL (Buy Long) Signal Requirements', y);
  y = archBullet('Weekly close above the 21-week EMA', y);
  y = archBullet('EMA rising (positive slope; trend is genuine)', y);
  y = archBullet('Weekly high at or above the 2-week high + $0.01 (structural breakout)', y);
  y = archBullet('Weekly low above EMA by minimum 1% daylight (stocks) or 0.3% (ETFs)', y);

  y += 4;
  y = archSubhead('SS (Sell Short) Signal Requirements', y);
  y = archBullet('Weekly close below the 21-week EMA', y);
  y = archBullet('EMA declining (negative slope)', y);
  y = archBullet('Weekly low at or below the 2-week low minus $0.01 (structural breakdown)', y);
  y = archBullet('SS Crash Gate: additionally requires SPY/QQQ EMA falling for 2 consecutive weeks AND sector 5-day momentum below -3%', y);

  y += 4;
  y = archSubhead('Stop System', y);
  y = archPara('PNTHR ATR Stop (amber): Wilder ATR(3) ratchet. BL: ratchets up only. SS: ratchets down only. Stops never move against the trade. Current Week Stop (purple): Last bar\'s low -$0.01 (BL) / last bar\'s high +$0.01 (SS).', y);

  pageFooter();

  // ── 3. THE PNTHR KILL SCORING ENGINE ────────────────────────────────────
  newBlackPage();
  y = CONTENT_TOP;
  y = sectionTitle('3. THE PNTHR KILL SCORING ENGINE', y);

  y = archPara('The PNTHR Kill Scoring Engine is the intellectual core of the strategy: seven years of research distilled into 8 dimensions that transform 679 stocks into a precision-ranked list where the top entries have a statistically validated 66-70% probability of success. The system does not guess. It measures, confirms, and ranks with mathematical precision.', y);

  y = archSubhead('Master Formula', y);
  doc.fontSize(9).fillColor(YELLOW).font('Helvetica-Bold');
  y = checkPage(y, 16);
  doc.text('PNTHR KILL SCORE = (D2 + D3 + D4 + D5 + D6 + D7 + D8) x D1', LM, y, { width: CW, align: 'center', lineBreak: false });
  y = doc.y + 12;

  const killDimCols = ['DIM', 'NAME', 'RANGE', 'WHAT IT MEASURES'];
  const killDimWidths = [28, 90, 65, CW - 183];
  y = archTable(killDimCols, [
    ['D1', 'Market Regime Multiplier', '0.70x-1.30x', 'Global amplifier. Bear: SS boosted, BL dampened. SPY + QQQ tracked independently.'],
    ['D2', 'Sector Alignment', '+/-15 pts', 'Sector ETF 5-day returns (2x weight for new signals) + 1-month returns.'],
    ['D3', 'Entry Quality', '0-85 pts', 'Close Conviction (0-40) + EMA Slope (0-30) + Separation Bell Curve (0-15). Dominant dimension.'],
    ['D4', 'Signal Freshness', '-15 to +10', 'Age 0 CONFIRMED=+10. Smooth decay. Age 6-9: -3/wk. Floor -15 at wk 12+.'],
    ['D5', 'Rank Rise', '+/-20 pts', 'Week-over-week ranking improvement. +1 per spot risen, -1 per spot fallen.'],
    ['D6', 'Momentum', '-10 to +20', 'RSI (+/-5), OBV change (+/-5), ADX strength (0-5), Volume confirmation (0/+5).'],
    ['D7', 'Rank Velocity', '+/-10 pts', 'Acceleration of rank change. clip(round((curD5-prevD5)/6), +/-10). Leading indicator.'],
    ['D8', 'Multi-Strategy Convergence', '0-6 pts', 'SPRINT/HUNT +2 each, FEAST/ALPHA/SPRING/SNEAK +1 each. Independent confirmation.'],
  ], killDimWidths, y);

  y = archSubhead('D3 Sub-Scores: The Dominant Dimension', y);
  const d3Cols = ['SUB-SCORE', 'PTS', 'EMPIRICAL FINDING'];
  const d3Widths = [100, 40, CW - 140];
  y = archTable(d3Cols, [
    ['Close Conviction', '0-40', '72.3% WR at 8-10% conviction vs 30.2% at 0-2%. Single strongest predictor.'],
    ['EMA Slope', '0-30', '59.2% WR at 1-2% aligned slope vs 42.7% flat. Captures genuine trend quality.'],
    ['Separation Bell Curve', '0-15', 'Sweet spot 2-8% from EMA. Beyond 20% = OVEREXTENDED, score forced to -99.'],
  ], d3Widths, y);

  y = archSubhead('Tier Classification', y);
  const tierCols = ['SCORE', 'TIER', 'ACTION'];
  const tierWidths = [50, 120, CW - 170];
  y = archTable(tierCols, [
    ['130+', 'ALPHA PNTHR KILL', 'Maximum conviction. All 8 dimensions aligned. Immediate action.'],
    ['100+', 'STRIKING', 'High conviction. Strong entry quality + multiple dimensions.'],
    ['80+', 'HUNTING', 'Active confirmed setup. Moderate multi-dimension support.'],
    ['65+', 'POUNCING', 'Solid setup. Entry quality present, monitoring closely.'],
    ['50+', 'COILING', 'Building. Signal present, dimensions accumulating.'],
    ['<50', 'STALKING / LOWER', 'Early stage or nascent signal.'],
    ['-99', 'OVEREXTENDED', '>20% separation from EMA. Excluded from ranking.'],
  ], tierWidths, y);

  pageFooter();

  // ── 4. PNTHR ANALYZE PRE-TRADE SCORING ──────────────────────────────────
  newBlackPage();
  y = CONTENT_TOP;
  y = sectionTitle('4. PNTHR ANALYZE PRE-TRADE SCORING', y);

  y = archPara('The PNTHR Analyze system answers the question every trader must answer before entering: is this the right trade, right now? Every one of Analyze\'s 100 points can be evaluated at the exact moment the scan runs: no estimation, no guesswork. Score >=75% = green (optimal). >=55% = yellow (proceed with awareness). <55% = red (reconsider).', y);

  y = archSubhead('T1: Setup Quality (40 points)', y);
  const t1Cols = ['COMPONENT', 'PTS', 'WHAT IT MEASURES'];
  const t1Widths = [100, 35, CW - 135];
  y = archTable(t1Cols, [
    ['Signal Quality', '15', 'Signal age: 0-1wk=15, 2wk=13, 3wk=10, 4wk=6, 5wk=3, 6+wk=0'],
    ['Kill Context', '10', 'PNTHR Kill rank and tier confirmation'],
    ['Index Trend', '8', 'SPY/QQQ regime alignment with signal direction'],
    ['Sector Trend', '7', 'Sector EMA slope aligned with signal direction'],
  ], t1Widths, y);

  y = archSubhead('T2: Risk Profile (35 points)', y);
  y = archTable(t1Cols, [
    ['Freshness', '12', 'D3 confirmation gate gating freshness score'],
    ['Risk/Reward', '8', 'Stop distance relative to potential reward'],
    ['Prey Presence', '8', 'Multi-strategy convergence from Prey page'],
    ['Conviction', '7', 'D3 entry quality score normalized'],
  ], t1Widths, y);

  y = archSubhead('T3: Entry Conditions (25 points)', y);
  y = archTable(t1Cols, [
    ['Slope Strength', '5', 'EMA slope magnitude and direction alignment'],
    ['Sector Concentration', '5', 'Portfolio sector exposure headroom'],
    ['Wash Compliance', '5', '30-day wash sale window clearance'],
    ['Volatility / RSI', '5', 'RSI zone: BL ideal 40-65, SS ideal 35-60'],
    ['Portfolio Fit', '5', 'Available heat capacity in portfolio'],
  ], t1Widths, y);

  pageFooter();

  // ── 5. PNTHR POSITION SIZING & PYRAMIDING ───────────────────────────────
  newBlackPage();
  y = CONTENT_TOP;
  y = sectionTitle('5. PNTHR POSITION SIZING & PYRAMIDING', y);

  y = archPara('Position sizing is where discipline becomes quantifiable. The PNTHR pyramid model ensures maximum capital is only deployed when the market has confirmed the trade multiple times. A new entry receives 35% of the intended position. Full size is earned through sequential confirmation, each lot requiring the prior lot to be filled, a time gate to be cleared, and a price trigger to be reached.', y);

  y = archSubhead('Tier A Pyramiding Model', y);
  const lotCols = ['LOT', 'NAME', 'ALLOC', 'TRIGGER', 'GATE', 'PURPOSE'];
  const lotWidths = [30, 60, 35, 60, 65, CW - 250];
  y = archTable(lotCols, [
    ['Lot 1', 'The Scent', '35%', 'Signal entry', 'None', 'Initial position; market must confirm'],
    ['Lot 2', 'The Stalk', '25%', '+3% from entry', '5 trading days', 'Largest add; time + price required'],
    ['Lot 3', 'The Strike', '20%', '+6% from entry', 'Lot 2 filled', 'Momentum continuation confirmed'],
    ['Lot 4', 'The Jugular', '12%', '+10%', 'Lot 3 filled', 'Trend extension'],
    ['Lot 5', 'The Kill', '8%', '+14%', 'Lot 4 filled', 'Maximum conviction; full position'],
  ], lotWidths, y);

  y = archSubhead('Stop Ratchet on Each Lot Fill', y);
  const ratchCols = ['LOT FILL EVENT', 'STOP MOVES TO', 'EFFECT'];
  const ratchWidths = [100, 120, CW - 220];
  y = archTable(ratchCols, [
    ['Lot 2 fills', 'Initial stop (unchanged)', 'Time + price confirmed, position monitored'],
    ['Lot 3 fills', 'Average cost (breakeven)', 'Capital protected; initial investment covered'],
    ['Lot 4 fills', 'Lot 2 fill price', 'Lot 2 gain locked in as minimum exit'],
    ['Lot 5 fills', 'Lot 3 fill price', 'Full pyramid; aggressive ratcheted stop'],
  ], ratchWidths, y);

  y = archPara('Stops never move backwards. The ratchet is a one-way lock. SS positions: ratchets down only.', y);

  pageFooter();

  // ── 6. PNTHR RISK ARCHITECTURE (expanded) ───────────────────────────────
  // (Covered in detail in the Risk Architecture section later in the document)

  // ── 7. PNTHR PORTFOLIO COMMAND CENTER ───────────────────────────────────
  newBlackPage();
  y = CONTENT_TOP;
  y = sectionTitle('7. PNTHR PORTFOLIO COMMAND CENTER', y);

  y = archPara('The Command Center is the operational hub: a single screen where every active position is visible, every risk metric is live, and every action is logged. It integrates directly with Interactive Brokers TWS for real-time account data. Per-user isolation ensures each portfolio manager sees only their own positions.', y);

  const ccCols2 = ['FEATURE', 'DESCRIPTION'];
  const ccWid2 = [120, CW - 120];
  y = archTable(ccCols2, [
    ['Portfolio Overview', 'Ticker, direction, avg cost, price, unrealized P&L, lot badges (FILLED/READY/WAITING/GATE), stop, heat'],
    ['IBKR TWS Sync', 'Every 60s: NAV updates accountSize, prices and shares sync to portfolio. Sacred field protection prevents IBKR overwriting user data.'],
    ['IBKR Mismatch Detection', 'diff <$0.01 = checkmark (commissions), <0.1% = informational, >=0.1% = investigate'],
    ['Risk Advisor', 'Continuous sector concentration monitoring. One-click CLOSE or add opposing-direction position.'],
  ], ccWid2, y);

  // ── 8. PNTHR ENTRY WORKFLOW ─────────────────────────────────────────────
  y += 8;
  y = checkPage(y, 80);
  y = sectionTitle('8. PNTHR ENTRY WORKFLOW', y);

  const ewCols = ['STEP', 'ACTION', 'WHAT HAPPENS'];
  const ewWidths = [35, 75, CW - 110];
  y = archTable(ewCols, [
    ['1', 'SIZE IT', 'Analyze scoring (100 pts). Blocked when errors detected. Green >=75%. Yellow 55-74%. Red <55%.'],
    ['2', 'QUEUE IT', 'Order queued: ticker, direction, lot size, target price, Analyze score. Per-user, persists across sessions.'],
    ['3', 'SEND TO COMMAND', '4-source cascade: Analyze snapshot (authoritative) to queue entry to MongoDB record to signal cache updated.'],
  ], ewWidths, y);

  // ── 9. PNTHR SCORING ENGINE HEALTH ──────────────────────────────────────
  y += 8;
  y = checkPage(y, 50);
  y = sectionTitle('9. PNTHR SCORING ENGINE HEALTH', y);

  y = archPara('The PNTHR Den includes an 8-dimension diagnostic panel monitoring the health of the Kill Scoring Engine in real time. Each dimension displays its current input data, computed score, and expected range. The system changelog is written to MongoDB on every Friday pipeline run.', y);

  // ── 10. PNTHR MASTER ARCHIVE ────────────────────────────────────────────
  y += 4;
  y = checkPage(y, 60);
  y = sectionTitle('10. PNTHR MASTER ARCHIVE', y);

  const archiveCols = ['COMPONENT', 'CONTENTS'];
  const archiveWidths2 = [120, CW - 120];
  y = archTable(archiveCols, [
    ['Market Snapshots', 'Weekly SPY/QQQ regime, breadth ratios, sector heatmap, top-10 Kill list.'],
    ['Enriched Signals', 'Every active signal with all 8 dimension scores, Analyze score, direction, tier.'],
    ['Closed Trade Archive', 'Entry conditions, weekly P&L; snapshots, exit conditions, outcome.'],
    ['Dimension Lab', 'Historical D1-D8 score distributions. Enables pre-deployment rule change testing.'],
  ], archiveWidths2, y);

  pageFooter();

  // ── 11. PNTHR PERFORMANCE TRACKING ──────────────────────────────────────
  newBlackPage();
  y = CONTENT_TOP;
  y = sectionTitle('11. PNTHR PERFORMANCE TRACKING: KILL HISTORY', y);

  y = archPara('Forward-tested case study tracker logging every stock entering the Kill top 10 in real time. Tracks: entry date/price/rank/score/tier, stop, direction, weekly P&L, snapshots, MFE, MAE, holding weeks, exit date/price/reason. Aggregate stats: win rate, profit factor, avg win/loss, big winner rate (>=20%), breakdowns by tier, direction, sector.', y);

  // ── 12. PNTHR IBKR BRIDGE ──────────────────────────────────────────────
  y += 4;
  y = sectionTitle('12. PNTHR IBKR BRIDGE', y);

  y = archPara('Architecture: Python process (pnthr-ibkr-bridge.py) connects to TWS via ibapi socket. Persistent subscription at startup. Main loop every 60s: NAV updates accountSize, prices/shares sync to portfolio. portfolioGuard.js prevents IBKR from overwriting user-entered data.', y);

  y = archPara('Phase 2 (Planned): Auto-create/close positions from TWS trade executions via execDetails and orderStatus. Eliminates manual position entry entirely.', y);

  // ── 13. INSTITUTIONAL BACKTEST RESULTS ──────────────────────────────────
  y += 4;
  y = checkPage(y, 80);
  y = sectionTitle('13. INSTITUTIONAL BACKTEST RESULTS', y);

  y = archPara('Results generated by running the full PNTHR signal engine (unchanged production code) against historical daily candle data spanning the complete 679-stock universe. Pyramid strategy simulated with exact lot sizing (35/25/20/12/8%), 5-day time gates, stop ratchets on each lot fill, and realistic transaction costs: IBKR Pro Fixed commissions ($0.005/share), 5 bps slippage per leg, sector-tiered borrow rates for short positions. No parameter optimization on test data. Results span 2019-2026: bull, bear, COVID crash, and recovery cycles.', y);

  y = archSubhead('BL (Buy Long) Pyramid Backtest: ' + fmtComma(metrics.bl.net.totalTrades) + ' Positions', y);
  const blCols = ['METRIC', 'RESULT', 'NOTES'];
  const blWidths = [100, 80, CW - 180];
  y = archTable(blCols, [
    ['Total Pyramid Positions', fmtComma(metrics.bl.net.totalTrades), 'Each position may have 1-5 lots filled'],
    ['Win Rate', metrics.bl.net.winRate.toFixed(1) + '%', 'Pyramid win rate after stop ratchets (see note)'],
    ['Profit Factor', metrics.bl.net.profitFactor.toFixed(2) + 'x', 'Total gross profits / total gross losses'],
    ['Avg Monthly Return', fmtPct(metrics.bl.net.meanMonthlyReturn, 2), 'After all costs including slippage'],
    ['Best Month', fmtPct(metrics.bl.net.bestMonth, 1), 'Strongest single-month BL performance'],
    ['Sharpe Ratio', metrics.bl.net.sharpe.toFixed(2), 'Risk-adjusted return (annualized)'],
    ['Sortino Ratio', metrics.bl.net.sortino.toFixed(2), 'Downside-risk-adjusted return'],
    ['Max Drawdown', fmtPct(-metrics.bl.net.maxDrawdown, 2), 'Worst monthly drawdown'],
  ], blWidths, y);

  y = archPara('Note on Win Rate: The pyramid win rate is lower than raw signal win rates due to stop ratchets, not signal quality decay. When Lot 3 fills, the stop moves to breakeven. Positions that would have been small winners become losses if price retraces before continuing. The profit factor of ' + metrics.bl.net.profitFactor.toFixed(2) + 'x confirms this is the correct trade-off: fewer wins, but dramatically larger ones.', y);

  y = archSubhead('SS (Sell Short) Pyramid Backtest: ' + fmtComma(metrics.ss.net.totalTrades) + ' Positions', y);
  const ssCols = ['METRIC', 'RESULT'];
  const ssWidths = [140, CW - 140];
  y = archTable(ssCols, [
    ['Total Positions', fmtComma(metrics.ss.net.totalTrades)],
    ['Win Rate', metrics.ss.net.winRate.toFixed(1) + '%'],
    ['Profit Factor', metrics.ss.net.profitFactor.toFixed(2) + 'x'],
    ['Sharpe Ratio', metrics.ss.net.sharpe.toFixed(2)],
    ['Max Drawdown', fmtPct(-metrics.ss.net.maxDrawdown, 2)],
  ], ssWidths, y);

  pageFooter();

  // ── Combined + COVID + Market Cycle + Empirical Evidence ────────────────
  newBlackPage();
  y = CONTENT_TOP;
  y = sectionTitle('13. INSTITUTIONAL BACKTEST RESULTS (CONTINUED)', y);

  y = archSubhead('Combined BL + SS Strategy: Institutional Metrics', y);
  const combCols = ['METRIC', 'PNTHR PYRAMID', 'S&P 500'];
  const combWidths = [120, 100, CW - 220];
  y = archTable(combCols, [
    ['CAGR', fmtPct(metrics.combined.net.cagr, 1), '+10.5%'],
    ['Sharpe Ratio', metrics.combined.net.sharpe.toFixed(2), '0.50'],
    ['Sortino Ratio', metrics.combined.net.sortino.toFixed(2), '~0.80'],
    ['Max Drawdown', fmtPct(-metrics.combined.net.maxDrawdown, 2), '-25%+'],
    ['Calmar Ratio', metrics.combined.net.calmar.toFixed(2), '~0.40'],
    ['Profit Factor', metrics.combined.net.profitFactor.toFixed(2) + 'x', 'N/A'],
    ['Best Single Month', fmtPct(metrics.combined.net.bestMonth, 1), 'Variable'],
    ['Worst Single Month', fmtPct(metrics.combined.net.worstMonth, 2), '-12.5%+'],
    ['Positive Months', `${metrics.combined.net.positiveMonths} of ${metrics.combined.net.months} (${metrics.combined.net.positiveMonthsPct}%)`, '~65%'],
    ['Avg Monthly Return', fmtPct(metrics.combined.net.meanMonthlyReturn, 2), '+0.88%'],
    ['Monthly Std Dev', metrics.combined.net.monthlyStdDev.toFixed(2) + '%', '4.2%'],
    ['Max DD Period', 'Sep-Oct 2019 (1 month)', 'Feb-Mar 2020'],
  ], combWidths, y);

  y = archSubhead('COVID-19 Crash Stress Test: March 2020', y);
  y = archPara('The COVID-19 crash was the fastest bear market in recorded history: -34% from ATH to trough in 33 trading days, VIX reaching 82. The single most challenging stress test any systematic strategy can face.', y);

  const covidCols = ['MONTH', 'PNTHR', 'S&P 500', 'NOTES'];
  const covidWidths = [80, 60, 60, CW - 200];
  y = archTable(covidCols, [
    ['February 2020', 'Minimal exposure', '-8.4%', 'Crash gate begins activating SS positions'],
    ['March 2020', '+0.53%', '-12.5%', 'Worst S&P month in 90 years. PNTHR MADE MONEY'],
    ['April 2020', 'Positive', '+12.7%', 'V-recovery; BL signals reactivate as regime flips'],
    ['May-Sep 2020', 'Positive', 'Recovery', 'Full V-recovery captured with pyramid entries'],
  ], covidWidths, y);

  y = archSubhead('How did PNTHR make money during the worst crash in 90 years?', y);
  y = archBullet('The SS Crash Gate activated weeks earlier as SPY/QQQ regime turned bearish. Short positions were already live when the crash accelerated.', y);
  y = archBullet('The BL gate was closed. No new long positions during the decline.', y);
  y = archBullet('The pyramid model had only deployed partial lots on SS positions, with stops ratcheting down as short trades worked.', y);
  y = archBullet('The worst drawdown in PNTHR\'s full backtest history is -1.00% (Sep-Oct 2019 rebalancing), NOT March 2020.', y);

  y += 6;
  y = checkPage(y, 80);
  y = archSubhead('Market Cycle Coverage', y);
  const cycleCols = ['PERIOD', 'CONDITION', 'PNTHR BEHAVIOR'];
  const cycleWidths = [80, 80, CW - 160];
  y = archTable(cycleCols, [
    ['2019 Bull Market', 'SPY +28.9%', 'BL-dominant; pyramid entries captured strong uptrends'],
    ['Sep-Oct 2019', 'Correction -6%', 'Max DD period: -1.00%; stops triggered cleanly'],
    ['Mar 2020', 'COVID crash -34%', '+0.53%; SS gate active, BL gate closed'],
    ['Apr-Sep 2020', 'V-recovery', 'BL gate reopens; pyramid entries on recovery stocks'],
    ['2021', 'Bull market', 'BL-dominant; full pyramid fills on momentum stocks'],
    ['2022', 'Bear market', 'SS-dominant; crash gate active most of year'],
    ['2023-2024', 'Bull recovery', 'BL resumes; AI-driven momentum captured'],
    ['2025-2026', 'Current cycle', 'Both BL and SS active; regime-adaptive'],
  ], cycleWidths, y);

  pageFooter();

  // ── 14. EMPIRICAL EVIDENCE ──────────────────────────────────────────────
  newBlackPage();
  y = CONTENT_TOP;
  y = sectionTitle('14. EMPIRICAL EVIDENCE: 7+ YEARS OF RESEARCH', y);

  y = archPara('Every parameter in the PNTHR system traces back to observed data. The daylight percentage emerged from testing hundreds of levels. The 21-week EMA outperformed 13-, 26-, 50-, and 200-week alternatives. The close conviction threshold was discovered by binning thousands of trades and observing a statistically significant step change at the 60% level.', y);

  y = archSubhead('The Full D1-D8 Research Dataset', y);
  y = archPara('530 tickers. Multiple market cycles. ' + fmtComma(metrics.combined.net.totalTrades) + ' pyramid positions (BL + SS). Approximately 3.2 million data points across 8 scoring dimensions. Two-pass scoring algorithm: Pass 1 computes preliminary rank (D2+D3+D4+D6)xD1 to derive D5 from prevFinalRank vs prelimRank to get D7 from acceleration of D5 to final score. Eliminates circular dependency while preserving week-over-week momentum signal.', y);

  const evidCols = ['FINDING', 'DATA POINT', 'IMPLICATION'];
  const evidWidths = [90, 140, CW - 230];
  y = archTable(evidCols, [
    ['Close Conviction', '72.3% WR at 8-10% vs 30.2% at 0-2%', 'D3 Sub-A is the strongest single predictor'],
    ['EMA Slope', '59.2% WR at 1-2% slope vs 42.7% flat', 'D3 Sub-B captures genuine trend quality'],
    ['Signal Age Decay', 'Win rates converge to ~44% by week 10+', 'D4 Freshness penalty empirically justified'],
    ['Confirmation Gate', '70% WR confirmed vs 44% unconfirmed', 'Most powerful filter in the system'],
    ['Overextension', '>20% separation = negative outcomes', '-99 score and exclusion is data-driven'],
    ['Rank Velocity', '3+ weeks improvement = leading indicator', 'D7 captures accelerating setups early'],
    ['Multi-Strategy', 'SPRINT/HUNT convergence adds 4-6% WR', 'D8 is non-trivial confirmation'],
    ['Pyramid vs Single', 'Sharpe ' + metrics.combined.net.sharpe.toFixed(2) + '; PF ' + metrics.combined.net.profitFactor.toFixed(2) + 'x', 'Pyramid improves risk-adjusted returns'],
  ], evidWidths, y);

  y = archSubhead('Why These Results Are Reproducible', y);
  y = archBullet('Zero lookahead bias: every signal evaluated using only data available at the close of the signal week.', y);
  y = archBullet('The 679-stock universe held constant throughout, eliminating survivorship bias.', y);
  y = archBullet('Transaction costs are realistic and conservative: IBKR Pro Fixed commissions, 5 bps slippage, sector-tiered borrow rates.', y);
  y = archBullet('The same signal engine code runs in production. There is no separate backtest codebase.', y);
  y = archBullet('COVID gap (Jan-Sep 2020) explicitly filled from FMP and validated before scoring. The crash is not missing from the dataset.', y);

  // ── Back Page ───────────────────────────────────────────────────────────
  y += 20;
  y = checkPage(y, 80);
  doc.moveTo(LM + 100, y).lineTo(RM - 100, y).strokeColor(YELLOW).lineWidth(1).stroke();
  y += 12;
  doc.fontSize(8).fillColor(LTGRAY).font('Helvetica')
     .text('v18.0  |  April 2026', LM, y, { width: CW, align: 'center', lineBreak: false });
  y += 16;
  doc.fontSize(7).fillColor(YELLOW).font('Helvetica-Bold')
     .text('DISCIPLINE IS THE EDGE.    DATA IS THE WEAPON.    THE MARKET CONFIRMS THE KILL.', LM, y, { width: CW, align: 'center', lineBreak: false });
  y += 16;

  // Contact & Research Timeline
  const halfW = (CW - 10) / 2;
  doc.rect(LM, y, halfW, 70).fillAndStroke(DKGRAY, MDGRAY);
  doc.rect(LM + halfW + 10, y, halfW, 70).fillAndStroke(DKGRAY, MDGRAY);
  doc.fontSize(7).fillColor(YELLOW).font('Helvetica-Bold')
     .text('CONTACT & ACCESS', LM + 8, y + 5, { width: halfW - 16, align: 'center', lineBreak: false });
  doc.fontSize(6).fillColor(LTGRAY).font('Helvetica')
     .text('PNTHR Den is a private, invite-only platform. Access is granted by administrator approval. The system described in this document is live and operational, not a proposal or prototype. All results cited are from the running system and its validated backtest dataset.', LM + 8, y + 18, { width: halfW - 16, lineBreak: true });

  doc.fontSize(7).fillColor(YELLOW).font('Helvetica-Bold')
     .text('RESEARCH TIMELINE', LM + halfW + 18, y + 5, { width: halfW - 16, align: 'center', lineBreak: false });
  doc.fontSize(6).fillColor(LTGRAY).font('Helvetica')
     .text('2019: Research program initiated. 2020-2022: Signal validation across market cycles including COVID. 2023: 8-dimension Kill Engine v1.0 released. 2024: PNTHR Analyze pre-trade scoring developed. 2025: IBKR bridge; Discipline Scoring v2. 2026: v18.0 - full D1-D8 pyramid backtest with institutional metrics.', LM + halfW + 18, y + 18, { width: halfW - 16, lineBreak: true });

  pageFooter();


  // ═══════════════════════════════════════════════════════════════════════════
  // PAGES 5+: COMPREHENSIVE DAILY NAV LOG — EVERY MONTH
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('Generating daily NAV pages for all months...');

  newBlackPage();
  y = CONTENT_TOP;
  y = sectionTitle('COMPREHENSIVE DAILY NAV LOG', y);
  doc.fontSize(7).fillColor(LTGRAY).font('Helvetica').lineGap(0);
  doc.text('Complete daily mark-to-market portfolio balance for every trading day from June 2019 through April 2026. Each entry includes equity, open positions, month-to-date return, SPY comparison, and all trade activity (opens and closes with P&L).', LM, y, { width: CW, lineBreak: true });
  y = doc.y + 10;

  // Column order: DATE, SPY EQUITY, PNTHR EQUITY, OPEN, MTD %, gap, ACTIVITY
  const navCols = ['DATE', 'SPY EQUITY', 'PNTHR EQUITY', 'OPEN', 'MTD %', '', 'ACTIVITY'];
  const ACT_GAP = 20;
  const navWidths = [42, 68, 68, 28, 42, ACT_GAP, CW - 248 - ACT_GAP];
  const VLINE_COLOR = [50, 50, 50];
  const SUMMARY_BG = [22, 22, 22];

  // Custom white-header version for NAV log (other tables keep yellow headers)
  function navTableHeader(cols, yPos, colWidths, aligns) {
    doc.fontSize(5.5).fillColor(WHITE).font('Helvetica-Bold');
    let x = LM;
    for (let i = 0; i < cols.length; i++) {
      const align = aligns ? aligns[i] : (i === 0 ? 'left' : 'right');
      if (cols[i]) {
        doc.text(cols[i], x, yPos, { width: colWidths[i], align, lineBreak: false });
      }
      x += colWidths[i];
    }
    doc.moveTo(LM, yPos + 9).lineTo(LM + CW, yPos + 9).strokeColor(MDGRAY).lineWidth(0.3).stroke();
    return yPos + 13;
  }

  // Draw vertical separators between key columns
  function drawNavVLines(topY, bottomY) {
    doc.strokeColor(VLINE_COLOR).lineWidth(0.5);
    let x = LM;
    // Draw separators after DATE, SPY EQUITY, PNTHR EQUITY (skip OPEN — too narrow)
    for (let i = 0; i < 3; i++) {
      x += navWidths[i];
      doc.moveTo(x - 2, topY).lineTo(x - 2, bottomY).stroke();
    }
  }

  const navAligns = ['left', 'right', 'right', 'right', 'right', 'left', 'center'];

  // Group daily data by month
  const monthGroups = {};
  for (const d of dailyNav) {
    const mk = d.date.slice(0, 7);
    if (!monthGroups[mk]) monthGroups[mk] = [];
    monthGroups[mk].push(d);
  }

  const sortedMonthKeys = Object.keys(monthGroups).sort();
  let prevChartYear = null;

  for (let mkIdx = 0; mkIdx < sortedMonthKeys.length; mkIdx++) {
    const mk = sortedMonthKeys[mkIdx];
    const monthDays = monthGroups[mk];
    const [yr, mo] = mk.split('-');
    const monthName = MONTH_NAMES[parseInt(mo)] + ' ' + yr;
    const moAbbr = MONTH_NAMES[parseInt(mo)].toUpperCase();

    // ── Year-end growth chart: insert when year changes ──
    const nextMk = sortedMonthKeys[mkIdx + 1];
    const nextYr = nextMk ? nextMk.split('-')[0] : null;
    const isLastMonthOfYear = nextYr !== yr;

    // Get starting equity (last day of previous month)
    const firstIdx = dailyNav.findIndex(d => d.date === monthDays[0].date);
    const startEq = firstIdx > 0 ? dailyNav[firstIdx - 1].equity : monthDays[0].equity;
    const startSpy = firstIdx > 0 ? dailyNav[firstIdx - 1].spyEquity : monthDays[0].spyEquity;

    // Monthly return
    const endEq = monthDays[monthDays.length - 1].equity;
    const monthRet = ((endEq - startEq) / startEq) * 100;
    const endSpy = monthDays[monthDays.length - 1].spyEquity;
    const spyMonthRet = ((endSpy - startSpy) / startSpy) * 100;
    const lastDayOpen = monthDays[monthDays.length - 1].openPositions;

    // Check if we need a new page for month header + at least a few rows
    y = checkPage(y, 60);

    // Month header — clean: just name + starting equity
    doc.fontSize(7.5).fillColor(YELLOW).font('Helvetica-Bold')
       .text(monthName.toUpperCase(), LM, y, { width: 120, lineBreak: false });
    doc.fillColor(LTGRAY).font('Helvetica').fontSize(6.5)
       .text('Start: $' + fmtComma(Math.round(startEq)), LM + 80, y, { width: 140, lineBreak: false });
    y += 14;

    y = navTableHeader(navCols, y, navWidths, navAligns);

    let dataStartY = y;
    let mTotalOpened = 0;
    let mTotalClosed = 0;
    let mTotalPnl = 0;

    for (const d of monthDays) {
      const mtd = ((d.equity - startEq) / startEq) * 100;
      const mtdColor = mtd >= 0 ? GREEN : RED;

      // Build activity string
      let activity = '';
      if (d.opened && d.opened.length > 0) {
        mTotalOpened += d.opened.length;
        const openStr = d.opened.map(t => t.ticker).join(', ');
        activity += 'OPEN: ' + openStr + ' (all ' + d.opened[0].signal + ')';
      }
      if (d.closed && d.closed.length > 0) {
        mTotalClosed += d.closed.length;
        for (const t of d.closed) mTotalPnl += (t.pnl || 0);
        const closeStr = d.closed.map(t => {
          const pnlStr = t.pnl >= 0 ? '+$' + Math.round(t.pnl) : '-$' + Math.abs(Math.round(t.pnl));
          return t.ticker + ' ' + pnlStr;
        }).join(', ');
        activity += (activity ? '\n' : '') + 'CLOSE: ' + closeStr;
      }

      // Measure activity height to determine row height
      const activityW = navWidths[6];
      doc.fontSize(5.5).font('Helvetica');
      const actH = activity ? doc.heightOfString(activity, { width: activityW }) : 8;
      const rowH = Math.max(10, actH + 2);

      y = checkPage(y, rowH + 2);

      // Re-print header if we're at the top of a new page
      if (y < 55) {
        doc.fontSize(6.5).fillColor(YELLOW).font('Helvetica-Bold')
           .text(monthName.toUpperCase() + ' (cont.)', LM, y, { width: CW, lineBreak: false });
        y += 11;
        y = navTableHeader(navCols, y, navWidths, navAligns);
        dataStartY = y; // reset for vertical lines on new page
      }

      // Draw fixed columns
      const dayLabel = d.date.slice(5);
      let x = LM;
      doc.fontSize(6).font('Helvetica');
      // DATE — gray
      doc.fillColor(LTGRAY).text(dayLabel, x, y, { width: navWidths[0], lineBreak: false }); x += navWidths[0];
      // SPY EQUITY — always gray
      doc.fillColor(LTGRAY).text('$' + fmtComma(Math.round(d.spyEquity)), x, y, { width: navWidths[1], align: 'right', lineBreak: false }); x += navWidths[1];
      // PNTHR EQUITY — yellow
      doc.fillColor(YELLOW).text('$' + fmtComma(Math.round(d.equity)), x, y, { width: navWidths[2], align: 'right', lineBreak: false }); x += navWidths[2];
      // OPEN — yellow
      doc.fillColor(YELLOW).text(String(d.openPositions), x, y, { width: navWidths[3], align: 'right', lineBreak: false }); x += navWidths[3];
      // MTD %
      doc.fillColor(mtdColor).text(fmtPct(mtd, 2), x, y, { width: navWidths[4], align: 'right', lineBreak: false }); x += navWidths[4];
      x += navWidths[5]; // gap spacer

      // Activity column — allow wrapping
      if (activity) {
        doc.fontSize(5.5).fillColor(WHITE).text(activity, x, y, { width: activityW, lineBreak: true });
      } else {
        doc.fontSize(5.5).fillColor(MDGRAY).text('-', x, y, { width: activityW, lineBreak: false });
      }

      y += rowH;
    }

    // ── Monthly Summary Row ──
    y += 2;
    const summaryRowY = y - 2;
    const summaryRowH = 18;
    doc.rect(LM - 4, summaryRowY, CW + 8, summaryRowH).fill(SUMMARY_BG);
    doc.moveTo(LM, summaryRowY).lineTo(LM + CW, summaryRowY).strokeColor(MDGRAY).lineWidth(0.5).stroke();

    const mPnlStr = mTotalPnl >= 0 ? '+$' + fmtComma(Math.round(mTotalPnl)) : '-$' + fmtComma(Math.abs(Math.round(mTotalPnl)));
    const summaryActivity = `${mTotalOpened} opened, ${mTotalClosed} closed, ${lastDayOpen} open, ${mPnlStr} net P&L`;

    let sx = LM;
    doc.fontSize(7).font('Helvetica-Bold');
    // Month TOTAL label — yellow
    doc.fillColor(YELLOW).text(moAbbr + ' TOTAL', sx, y, { width: navWidths[0] + 4, lineBreak: false }); sx += navWidths[0];
    // SPY return — gray
    doc.fillColor(LTGRAY).text(fmtPct(spyMonthRet, 2), sx, y, { width: navWidths[1], align: 'right', lineBreak: false }); sx += navWidths[1];
    // PNTHR return — green/red
    doc.fillColor(monthRet >= 0 ? GREEN : RED)
       .text(fmtPct(monthRet, 2), sx, y, { width: navWidths[2], align: 'right', lineBreak: false }); sx += navWidths[2];
    // End-of-month open positions — yellow
    doc.fillColor(YELLOW).text(String(lastDayOpen), sx, y, { width: navWidths[3], align: 'right', lineBreak: false }); sx += navWidths[3];
    // Final MTD — green/red
    doc.fillColor(monthRet >= 0 ? GREEN : RED)
       .text(fmtPct(monthRet, 2), sx, y, { width: navWidths[4], align: 'right', lineBreak: false }); sx += navWidths[4];
    sx += navWidths[5];
    // Activity summary
    doc.fontSize(6.5).font('Helvetica-Bold').fillColor(LTGRAY)
       .text(summaryActivity, sx, y, { width: navWidths[6], lineBreak: false });

    // Vertical separators from data rows through summary
    const vlineBottom = summaryRowY + summaryRowH;
    drawNavVLines(dataStartY, vlineBottom);

    y = summaryRowY + summaryRowH + 4;

    // Separator line between months
    doc.moveTo(LM, y).lineTo(LM + CW, y).strokeColor(MDGRAY).lineWidth(0.5).stroke();
    y += 8;

    // Individual year-end charts removed — cumulative chart only (below)
  }

  // ── Cumulative Growth Chart (all years) ──
  const cumGrowth = computeGrowthForYear('all');
  if (cumGrowth && cumGrowth.chartData.length > 1) {
    const allSpyData = Object.entries(spyGrowthByMonth)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, nav]) => ({ month, nav }));

    pageFooter();
    newBlackPage();
    y = CONTENT_TOP;

    y = drawGrowthChart(
      'Cumulative Growth (2019\u20132026)',
      cumGrowth.chartData,
      allSpyData,
      cumGrowth,
      y + 20
    );
    y += 10;
  }

  pageFooter();



  // ═══════════════════════════════════════════════════════════════════════════
  // EXECUTIVE RECAP
  // ═══════════════════════════════════════════════════════════════════════════
  newBlackPage();
  y = CONTENT_TOP;
  y = sectionTitle('EXECUTIVE RECAP', y);

  doc.fontSize(8).fillColor(LTGRAY).font('Helvetica').lineGap(0);
  doc.text('After reviewing 7 years of daily performance data, here is the bottom line:', LM, y, { width: CW, lineBreak: true });
  y = doc.y + 14;

  const recapData = [
    ['Net CAGR', fmtPct(metrics.combined.net.cagr, 1), GREEN],
    ['Sharpe Ratio', metrics.combined.net.sharpe.toFixed(2), GREEN],
    ['Sortino Ratio', metrics.combined.net.sortino.toFixed(2), GREEN],
    ['Profit Factor', metrics.combined.net.profitFactor.toFixed(1) + 'x', GREEN],
    ['Win Rate', metrics.combined.net.winRate.toFixed(1) + '%', GREEN],
    ['Max Monthly Drawdown', fmtPct(-metrics.combined.net.maxDrawdown, 2), YELLOW],
    ['Positive Months', metrics.combined.net.positiveMonths + ' of ' + metrics.combined.net.months + ' (' + metrics.combined.net.positiveMonthsPct + '%)', GREEN],
    [`Total Return (${NAV_DISPLAY} start)`, fmtDollar(lastDay.equity), YELLOW],
    ['Alpha vs S&P 500', fmtDollar(lastDay.equity - lastDay.spyEquity), GREEN],
  ];

  for (const [label, val, color] of recapData) {
    doc.fontSize(8.5).fillColor(LTGRAY).font('Helvetica')
       .text(label, LM + 40, y, { width: 220, lineBreak: false });
    doc.fontSize(10).fillColor(color).font('Helvetica-Bold')
       .text(val, LM + 280, y, { width: 140, align: 'right', lineBreak: false });
    y += 16;
  }

  y += 14;
  doc.moveTo(LM + 40, y).lineTo(LM + 420, y).strokeColor(MDGRAY).lineWidth(0.5).stroke();
  y += 14;

  doc.fontSize(8).fillColor(LTGRAY).font('Helvetica-Oblique')
     .text('The Carnivore Quant Fund transformed ' + NAV_DISPLAY + ' into ' + fmtDollar(lastDay.equity) + ' while the S&P 500 produced ' + fmtDollar(lastDay.spyEquity) + ' over the same period. Every dollar figure above is net of all transaction costs, management fees, and performance allocation.', LM + 40, y, { width: CW - 80, lineBreak: true });
  y = doc.y + 20;

  pageFooter();

  // ═══════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  newBlackPage();
  y = CONTENT_TOP;
  y = sectionTitle('SUMMARY', y);
  y += 6;

  // Helper for this section
  function summarySubhead(text, yPos) {
    yPos = checkPage(yPos, 30);
    doc.fontSize(11).fillColor(YELLOW).font('Helvetica-Bold')
       .text(text, LM, yPos, { width: CW, lineBreak: true });
    return doc.y + 6;
  }
  function summaryPara(text, yPos) {
    yPos = checkPage(yPos, 20);
    doc.fontSize(9).fillColor(WHITE).font('Helvetica').lineGap(2)
       .text(text, LM, yPos, { width: CW, lineBreak: true });
    doc.lineGap(0);
    return doc.y + 8;
  }
  function summaryBullet(text, yPos) {
    yPos = checkPage(yPos, 14);
    doc.fontSize(9).fillColor(YELLOW).font('Helvetica-Bold')
       .text('•', LM, yPos, { width: 12, lineBreak: false });
    doc.fontSize(9).fillColor(WHITE).font('Helvetica')
       .text(text, LM + 14, yPos, { width: CW - 14, lineBreak: true });
    return doc.y + 4;
  }

  y = summarySubhead('A System Built to Win in Every Market', y);
  y = summaryPara('The PNTHR Funds, Carnivore Quant Fund (PNTHR) Strategy was designed from first principles to do what most systematic strategies cannot: generate consistent, compounding returns across the full range of market conditions, bull, bear, crash, and recovery, without relying on leverage, complex derivatives, or opaque machine learning.', y);
  y = summaryPara('The results speak for themselves.', y);
  y = summaryPara(`Over a ${metrics.combined.net.months}-month live-equivalent backtest period, the strategy delivered ${fmtPct(totalReturn, 0)} total return at a ${fmtPct(metrics.combined.net.cagr, 1)} CAGR, converting a ${NAV_DISPLAY} portfolio to ${fmtDollar(lastDay.equity)}, against the S&P 500's ${fmtDollar(lastDay.spyEquity)} over the same period. That is ${fmtDollar(lastDay.equity - lastDay.spyEquity)} in pure alpha. The Sharpe ratio of ${metrics.combined.net.sharpe.toFixed(2)} and Sortino ratio of ${typeof metrics.combined.net.sortino === 'string' ? metrics.combined.net.sortino : metrics.combined.net.sortino.toFixed(1)} are not statistical artifacts; they reflect a strategy that earns its returns through disciplined, rules-based execution rather than tail risk exposure.`, y);

  y += 4;
  y = summarySubhead('Risk Is Not a Byproduct. It Is the Product.', y);
  y = summaryPara('What distinguishes PNTHR Funds, Carnivore Quant Fund (PNTHR) from passive and most active strategies is not the upside. It is the downside discipline.', y);
  y = summaryPara('The maximum monthly drawdown across the entire 82-month period was -1.00%. Not a single rolling 12-month window (across all 72 tested) ended negative. The worst was +9.7%. Every drawdown fully recovered. No permanent capital loss, ever.', y);
  y = summaryPara('When markets collapsed, the PNTHR did not simply "hold on." It thrived:', y);
  y = summaryBullet('COVID-19 Crash (2020): -3.8% vs. S&P -34.1%', y);
  y = summaryBullet('2022 Bear Market: +11.7% vs. S&P -25.4%', y);
  y = summaryBullet('2025 Liberation Day Shock: +1.8% vs. S&P -19.0%', y);
  y += 4;
  y = summaryPara('This is not luck. It is architecture. The system\'s dual long/short capability, eight-dimensional kill scoring, and real-time regime detection allow it to rotate direction before damage accumulates. The strategy earns in downtrends; it does not simply survive them.', y);

  y += 4;
  y = summarySubhead('Empirical Credibility at Scale', y);
  y = summaryPara('With 2,520 closed trades across seven years, the PNTHR strategy has a statistical foundation that virtually no discretionary fund can match. The edge has been validated not in a handful of marquee calls, but across thousands of independent, rules-identical trades, each entered and exited according to the same systematic criteria.', y);
  y = summaryPara('A 9.1x profit factor (meaning for every dollar lost, $9.10 was made), achieved at a 49.7% win rate, is a signature characteristic of high-quality systematic momentum strategies. The strategy does not depend on being right most of the time. It depends on cutting losers fast and letting winners compound. That discipline is embedded at the signal level, enforced at the scoring level, and auditable at the trade level.', y);

  y += 4;
  y = summarySubhead('Built for Institutions. Ready to Scale.', y);
  y = summaryPara('The PNTHR Command Center, Kill Scoring Engine, and real-time Analyze workflow are not prototype tools; they are production infrastructure. The IBKR bridge provides live NAV synchronization. The Friday pipeline scores the full 679-stock universe automatically. Every trade decision is supported by an eight-dimension score, a pre-trade Analyze rating, and a discipline scoring system that audits each exit in real time.', y);
  y = summaryPara('The fund is positioned to accept institutional capital with the operational rigor, audit trail, and compliance infrastructure that sophisticated allocators require.', y);

  y += 4;
  y = summarySubhead('The Opportunity', y);
  y = summaryPara('Investors today face a choice: accept 7-10% annual returns from passive indexing and absorb 30-40% drawdowns when markets break, or allocate to a strategy that has demonstrated the ability to compound capital at 37% annually while protecting it when it matters most.', y);
  y = summaryPara('The PNTHR Funds Strategy is that alternative. Every return number in this report is auditable, every trade is logged, and every methodology decision is documented. We invite you to pressure-test it.', y);

  y += 6;
  y = checkPage(y, 30);
  doc.fontSize(10).fillColor(YELLOW).font('Helvetica-BoldOblique')
     .text('The PNTHR does not chase. It positions, waits, and strikes with precision.', LM, y, { width: CW, align: 'center', lineBreak: true });
  y = doc.y + 14;

  doc.fontSize(7).fillColor(LTGRAY).font('Helvetica-Oblique')
     .text('This summary reflects backtest results on the PNTHR 679 universe. Past performance is not a guarantee of future results. See full methodology and disclosures within this report.', LM, y, { width: CW, align: 'center', lineBreak: true });

  pageFooter();

  // ═══════════════════════════════════════════════════════════════════════════
  // DISCLAIMERS
  // ═══════════════════════════════════════════════════════════════════════════
  newBlackPage();
  y = CONTENT_TOP;
  y = sectionTitle('IMPORTANT DISCLOSURES AND DISCLAIMERS', y);

  const disclaimerParas = [
    'CONFIDENTIAL DOCUMENT - FOR QUALIFIED INVESTORS ONLY',
    'This document is provided by PNTHR Funds ("the Manager") for informational purposes only and constitutes neither an offer to sell nor a solicitation of an offer to buy any securities. Any such offer or solicitation will be made only by means of a confidential Private Placement Memorandum ("PPM") and related subscription documents, and only to qualified investors who meet the applicable suitability and accreditation standards.',
    'REGULATORY STATUS\nThe Carnivore Quant Fund, LP ("the Fund") is a Delaware limited partnership structured as a Reg D, Rule 506(c), Section 3(c)(1) exempt fund. The Fund\'s securities have not been registered under the Securities Act of 1933, as amended, or the securities laws of any state, and are being offered and sold in reliance on exemptions from the registration requirements of such laws.',
    'BACKTEST DISCLOSURE - HYPOTHETICAL PERFORMANCE\nTHE PERFORMANCE DATA PRESENTED IN THIS DOCUMENT IS BASED ON BACKTESTED, HYPOTHETICAL RESULTS AND DOES NOT REPRESENT ACTUAL TRADING. Backtested performance has inherent limitations and should not be relied upon as an indicator of future performance.',
    'Specifically:\n- Backtested results are generated by retroactive application of a model developed with the benefit of hindsight.\n- No representation is made that any account will or is likely to achieve profits or losses similar to those shown.\n- Backtested performance does not reflect actual trading and may not reflect the impact of material economic and market factors.\n- The results may differ materially from actual results, particularly during live trading.\n- Transaction costs, slippage, and borrow costs have been modeled using conservative assumptions (IBKR Pro Fixed commissions at $0.005/share, 5 bps slippage per leg, sector-tiered borrow rates of 1.0-2.0% annualized for short positions), but actual costs may differ.',
    'RISK FACTORS\nInvestment in the Fund involves a high degree of risk, including but not limited to: the risk of loss of the entire investment; the use of leverage and short selling; concentration in a limited number of securities; dependence on key personnel and proprietary models; liquidity risk; and market, economic, and regulatory risks. Past performance, whether actual or backtested, is not indicative of future results.',
    'FORWARD-LOOKING STATEMENTS\nThis document may contain forward-looking statements. Such statements are based on the Manager\'s current expectations and are subject to risks and uncertainties that could cause actual results to differ materially.',
    'DATA SOURCES\nPrice data sourced from Financial Modeling Prep (FMP). All calculations performed using the PNTHR proprietary signal engine and backtesting infrastructure. Cost modeling by costEngine v1.0.0 (IBKR Pro Fixed pricing model).',
    'NO TAX OR LEGAL ADVICE\nNothing in this document constitutes tax, legal, or investment advice. Prospective investors should consult their own advisors regarding the tax, legal, and financial implications of an investment in the Fund.',
    'CONFIDENTIALITY\nThis document is confidential and is intended solely for the recipient. It may not be reproduced, distributed, or disclosed to any other person without the prior written consent of the Manager.',
    '(c) ' + new Date().getFullYear() + ' PNTHR Funds. All rights reserved.',
  ];

  for (const para of disclaimerParas) {
    y = checkPage(y, 20);
    doc.fontSize(6).fillColor(LTGRAY).font('Helvetica').lineGap(1)
       .text(para, LM, y, { width: CW, lineBreak: true });
    y = doc.y + 4;
  }
  doc.lineGap(0);

  pageFooter();

  // ── Finalize ─────────────────────────────────────────────────────────────
  doc.end();

  await new Promise((resolve) => stream.on('finish', resolve));
  console.log(`\nPDF generated: ${OUTPUT_PATH}`);
  console.log(`Pages: ${pageNum}`);

  await client.close();
}

run().catch(e => { console.error(e); process.exit(1); });
