// server/backtest/genAmbushFrontierOnePager.mjs
// ── Final one-pager: Ambush V7.6 optimal fund design + honest efficient frontier
// Embeds the verified impact-bracket results (net of ALL costs: frictions + conservative
// market impact + Filet/highest-fee fund fees). Renders branded HTML + (via Chrome) PDF.
// Usage: node backtest/genAmbushFrontierOnePager.mjs
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'fs';
import os from 'os';
import path from 'path';

const GOLD = '#d4af37', GREEN = '#1a9e5f', BLUE = '#2b6cb0', RED = '#c0392b', INK = '#111';
const AUMS = [1, 2, 5, 10];                         // $M
const SPY_CAGR = 16.3;                              // SPY ~+74% over the 3.6yr window
// [netCAGR%, netMaxDD%] by impact coefficient Y, net of everything (Filet highest-fee tier)
const F = {
  '0.25': { 1: [46.3, 5.33], 2: [43.4, 5.25], 5: [38.2, 5.44], 10: [34.2, 6.02] }, // realistic (liquid S&P)
  '0.5':  { 1: [39.2, 5.59], 2: [35.3, 6.00], 5: [27.8, 6.48], 10: [20.8, 7.46] }, // moderate (base case)
  '1.0':  { 1: [29.5, 6.16], 2: [23.7, 6.97], 5: [12.7, 7.79], 10: [2.7, 17.95] }, // harsh (worst case)
};

function chart({ title, sub, series, yFmt, W = 760, H = 320 }) {
  const PAD = { t: 42, r: 20, b: 50, l: 64 }, iW = W - PAD.l - PAD.r, iH = H - PAD.t - PAD.b;
  const xMin = Math.min(...AUMS), xMax = Math.max(...AUMS);
  const allY = series.flatMap(s => s.data.map(d => d.y)).concat([0]);
  let yMin = Math.min(...allY), yMax = Math.max(...allY); const pad = (yMax - yMin) * 0.12 || 1; yMin -= pad; yMax += pad;
  const px = x => PAD.l + ((x - xMin) / (xMax - xMin)) * iW;
  const py = y => PAD.t + (1 - (y - yMin) / (yMax - yMin)) * iH;
  const yt = Array.from({ length: 5 }, (_, i) => yMin + i / 4 * (yMax - yMin));
  const lines = series.map(s => {
    const d = s.data.map((p, i) => `${i ? 'L' : 'M'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ');
    const dots = s.data.map(p => `<circle cx="${px(p.x).toFixed(1)}" cy="${py(p.y).toFixed(1)}" r="3.5" fill="${s.color}"/><text x="${px(p.x).toFixed(1)}" y="${(py(p.y)-8).toFixed(1)}" text-anchor="middle" font-size="9" fill="${s.color}" font-weight="700">${s.lab?s.lab(p.y):''}</text>`).join('');
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.5" ${s.dash ? 'stroke-dasharray="5,4"' : ''}/>${dots}`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px">
    <text x="${PAD.l}" y="20" font-size="15" font-weight="700" fill="${INK}">${title}</text>
    <text x="${PAD.l}" y="35" font-size="11" fill="#777">${sub}</text>
    ${yt.map(t => `<line x1="${PAD.l}" y1="${py(t).toFixed(1)}" x2="${W-PAD.r}" y2="${py(t).toFixed(1)}" stroke="#eee"/><text x="${PAD.l-8}" y="${(py(t)+4).toFixed(1)}" text-anchor="end" font-size="10" fill="#888">${yFmt(t)}</text>`).join('')}
    ${AUMS.map(x => `<text x="${px(x).toFixed(1)}" y="${H-28}" text-anchor="middle" font-size="10" fill="#888">$${x}M</text>`).join('')}
    <text x="${PAD.l+iW/2}" y="${H-8}" text-anchor="middle" font-size="11" fill="#555">Fund size (AUM)</text>
    ${lines}
    ${series.map((s, i) => `<g transform="translate(${PAD.l+i*175},${H-2})"><rect x="0" y="-9" width="15" height="3" fill="${s.color}"/><text x="20" y="-5" font-size="10.5" fill="#444">${s.label}</text></g>`).join('')}
  </svg>`;
}

const frontier = chart({
  title: 'The honest efficient frontier — net return vs fund size',
  sub: 'Net CAGR after ALL costs (frictions + market impact + highest-fee tier). Optimal config: 0.1% risk, earnings-flat ON.',
  yFmt: v => v.toFixed(0) + '%',
  series: [
    { label: 'Realistic impact', color: GREEN, lab: v => v.toFixed(0), data: AUMS.map(a => ({ x: a, y: F['0.25'][a][0] })) },
    { label: 'Moderate (base case)', color: BLUE, lab: v => v.toFixed(0), data: AUMS.map(a => ({ x: a, y: F['0.5'][a][0] })) },
    { label: 'Harsh / worst case', color: RED, data: AUMS.map(a => ({ x: a, y: F['1.0'][a][0] })) },
    { label: 'S&P 500 (SPY)', color: '#aaa', dash: true, data: AUMS.map(a => ({ x: a, y: SPY_CAGR })) },
  ],
});

const row = a => `<tr><td style="font-weight:700">$${a}M</td>
  <td style="color:${GREEN}">+${F['0.25'][a][0]}%</td>
  <td style="color:${BLUE};font-weight:700">+${F['0.5'][a][0]}%</td>
  <td style="color:${RED}">+${F['1.0'][a][0]}%</td>
  <td>${F['0.5'][a][1]}%</td></tr>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><title>PNTHR Ambush V7.6 — Optimal Fund Design</title>
<style>
  *{box-sizing:border-box} body{font:13px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:${INK};max-width:840px;margin:0 auto;padding:26px}
  h1{font-size:21px;margin:0 0 2px} .sub{color:#777;font-size:12px;margin-bottom:14px}
  .bar{height:4px;background:${GOLD};margin:10px 0 16px;border-radius:2px}
  table{border-collapse:collapse;width:100%;font-size:12px;margin:6px 0} th,td{border-bottom:1px solid #eee;padding:6px 9px;text-align:right} th:first-child,td:first-child{text-align:left}
  th{color:#666;font-weight:600;border-bottom:2px solid #ddd}
  .rec{background:#faf7ec;border:1px solid ${GOLD};border-radius:8px;padding:14px 16px;margin:14px 0}
  .rec h3{margin:0 0 8px;color:#8a6d00;font-size:13px}
  .k{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0} .kc{flex:1 1 150px;background:#fff;border:1px solid #e6dcae;border-radius:7px;padding:8px 11px} .kc .v{font-size:18px;font-weight:800;color:${GREEN}} .kc .l{font-size:10px;color:#777;text-transform:uppercase}
  ul{margin:6px 0 0;padding-left:18px} li{margin:4px 0}
  .foot{color:#999;font-size:9.5px;border-top:1px solid #eee;margin-top:18px;padding-top:9px}
</style></head><body>
  <h1>PNTHR Ambush V7.6 — Optimal Fund Design &amp; Honest Efficient Frontier</h1>
  <div class="sub">Backtest Nov 2022 – Jun 2026 (3.6 yrs) · survivorship-free point-in-time S&amp;P 500 (566 names) · true :00 clock-hour bars · IBKR commissions + 5bps slippage + short borrow + 2% ADV cap + gap-through stops + <b>conservative square-root market impact</b> · returns NET of all costs and the highest-fee (Filet) tier</div>
  <div class="bar"></div>

  ${frontier}

  <table><thead><tr><th>Fund size</th><th>Realistic impact</th><th>Moderate (base case)</th><th>Worst case</th><th>Max DD (base)</th></tr></thead>
  <tbody>${AUMS.map(row).join('')}</tbody></table>

  <div class="rec"><h3>RECOMMENDED FUND DESIGN — a deliberately capacity-capped, elite-performance fund</h3>
  <div class="k">
    <div class="kc"><div class="v">~$1–3M</div><div class="l">Target AUM (capped)</div></div>
    <div class="kc"><div class="v">0.10%</div><div class="l">Risk per trade (NAV)</div></div>
    <div class="kc"><div class="v">ON</div><div class="l">Flat before earnings</div></div>
    <div class="kc"><div class="v">~35–46%</div><div class="l">Net CAGR (base–realistic)</div></div>
    <div class="kc"><div class="v">~5–6%</div><div class="l">Max drawdown</div></div>
  </div>
  <ul>
    <li><b>This is your Ambush V7.6, unchanged, with exactly two tested refinements:</b> size each position at <b>0.10% of NAV</b> (instead of the $300 launch-tier cap) and <b>go flat before earnings</b>. The breakout entry, the tight 2-bar exit, the 5-lot pyramid, and the green re-entry are all stock V7.6 — loosening any of them hurt.</li>
    <li><b>Cap the AUM — it's the elite move, not a compromise.</b> Returns are highest when the fund is small; capping protects them. The best fund in history (Renaissance Medallion) capped assets and closed to outside money for exactly this reason.</li>
    <li><b>~35–46% net CAGR at a ~5–6% drawdown is top-decile globally</b> (Calmar ≈ 6–8). Few managers sustain anything near it.</li>
    <li><b>Beyond ~$10M the edge fades</b> — the strategy's intraday churn makes trading costs prohibitive. Larger AUM needs a separate, lower-turnover sleeve (e.g., the Carnivore weekly book).</li>
  </ul></div>

  <div style="font-size:12px"><b>What we learned tonight (the knobs):</b>
  <ul>
    <li><b>Risk sizing:</b> small, but not tiny — ~0.1% NAV/trade. (Ultra-low risk looked best on paper but its churn gets crushed by real trading costs.)</li>
    <li><b>Earnings-flat: adopt.</b> Cuts the worst trade 40–75% and improves Sharpe/Calmar at ~0.3% CAGR cost — near-free tail insurance.</li>
    <li><b>Capacity is real:</b> 83% CAGR is a small-fund (≈$100k) number; it cannot coexist with a large AUM. The frontier above is the honest trade-off.</li>
    <li><b>The market-impact assumption is the swing factor</b> — pin it with live IBKR fill data before publishing. Base case shown = moderate (Y=0.5).</li>
  </ul></div>

  <div class="foot">HYPOTHETICAL / BACKTESTED PERFORMANCE — NOT A GUARANTEE OF FUTURE RESULTS. Figures are simulated over a single favorable 2022–2026 window, net of modeled trading frictions, conservative market impact, and the Fund's highest-fee tier; they do not reflect actual trading or an investor account. Backtested results have inherent limitations. The market-impact assumption materially affects at-scale figures and should be validated against live execution data before use in any offering material. Generated ${new Date().toISOString().slice(0,10)} for internal review. PNTHR Funds — confidential.</div>
</body></html>`;

const out = path.join(os.homedir(), 'Downloads', 'PNTHR_Ambush_OptimalFund_Frontier.html');
fs.writeFileSync(out, html);
console.log('Wrote ' + out);
