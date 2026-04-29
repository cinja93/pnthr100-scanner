// server/scripts_den/diagnoseXe.js
// ── Read-only diagnostic for XE — why does signalService return null? ──────
//
// Phase 2.1 of the Phase 4 D1 → Day 3 cleanup. XE is one of 4 IBKR positions
// that PNTHR doesn't track because Phase 3 refused to auto-open. Of the 4,
// QCOM/CRWD/META all returned signal=SE (algorithm has no anchor for a stop —
// genuinely manual-entry territory). XE returned signal=null AND ema=null —
// a different failure mode that suggests a data gap. This script probes each
// possible failure point so we can decide: code fix, manual entry, or both.
//
// Probes (all read-only):
//   1. FMP profile lookup        — does FMP know about XE at all?
//   2. FMP historical bars       — how much data is available?
//   3. PNTHR universe membership — is XE in pnthr_kill_appearances?
//   4. signalService output      — what does the live function return?
//   5. Common variations         — does XE.TO or similar return data?
//
// Run: node scripts_den/diagnoseXe.js

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
import { connectToDatabase } from '../database.js';
import { getSignals } from '../signalService.js';

const TICKER = 'XE';
const FMP_KEY = process.env.FMP_API_KEY;
if (!FMP_KEY) { console.error('FMP_API_KEY not set'); process.exit(1); }

const fromDate = (() => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 5);
  return d.toISOString().split('T')[0];
})();

console.log(`\n=== XE diagnostic ===\n  fromDate: ${fromDate}\n`);

// ── Probe 1: FMP profile lookup ────────────────────────────────────────────
console.log('─── 1. FMP profile lookup ───────────────────────────────────────');
let profile = null;
try {
  const r = await fetch(`https://financialmodelingprep.com/api/v3/profile/${TICKER}?apikey=${FMP_KEY}`);
  console.log(`   HTTP ${r.status}`);
  const data = await r.json();
  if (Array.isArray(data) && data.length > 0) {
    profile = data[0];
    console.log(`   companyName: ${profile.companyName || '—'}`);
    console.log(`   exchange:    ${profile.exchange || '—'}`);
    console.log(`   exchangeShortName: ${profile.exchangeShortName || '—'}`);
    console.log(`   sector:      ${profile.sector || '—'}`);
    console.log(`   industry:    ${profile.industry || '—'}`);
    console.log(`   isActivelyTrading: ${profile.isActivelyTrading}`);
    console.log(`   isFund:      ${profile.isFund}`);
    console.log(`   isEtf:       ${profile.isEtf}`);
    console.log(`   ipoDate:     ${profile.ipoDate || '—'}`);
    console.log(`   price:       ${profile.price}`);
  } else {
    console.log(`   ✗ FMP returned empty array — XE is NOT in FMP profile coverage.`);
  }
} catch (e) {
  console.log(`   ✗ profile fetch threw: ${e.message}`);
}

// ── Probe 2: FMP historical bars ───────────────────────────────────────────
console.log('\n─── 2. FMP historical bars ──────────────────────────────────────');
let barCount = 0;
try {
  const r = await fetch(
    `https://financialmodelingprep.com/api/v3/historical-price-full/${TICKER}?from=${fromDate}&apikey=${FMP_KEY}`
  );
  console.log(`   HTTP ${r.status}`);
  const data = await r.json();
  const bars = data?.historical || [];
  barCount = bars.length;
  console.log(`   bars returned: ${barCount}`);
  if (barCount > 0) {
    console.log(`   first bar: ${bars[bars.length - 1]?.date} close ${bars[bars.length - 1]?.close}`);
    console.log(`   last bar:  ${bars[0]?.date} close ${bars[0]?.close}`);
    console.log(`   spans:     ${bars[bars.length - 1]?.date} → ${bars[0]?.date}`);
  } else {
    console.log(`   ✗ EMPTY — FMP returns no historical bars for XE.`);
  }
  // We need at least emaPeriod + 2 weekly bars (default EMA period 21 → 23 weekly bars
  // = roughly 115+ daily bars at minimum). State machine needs 23+ weekly bars.
  const weeklyEstimate = Math.floor(barCount / 5);
  console.log(`   est weekly bars: ${weeklyEstimate} (need ≥ 23 for state machine to fire)`);
} catch (e) {
  console.log(`   ✗ historical fetch threw: ${e.message}`);
}

// ── Probe 3: PNTHR universe membership ─────────────────────────────────────
console.log('\n─── 3. PNTHR universe membership ────────────────────────────────');
const db = await connectToDatabase();
if (db) {
  const inAppearances = await db.collection('pnthr_kill_appearances').findOne({ ticker: TICKER });
  console.log(`   pnthr_kill_appearances:    ${inAppearances ? 'PRESENT' : 'NOT FOUND'}`);
  if (inAppearances) {
    console.log(`     firstAppearanceDate=${inAppearances.firstAppearanceDate} firstKillRank=${inAppearances.firstKillRank}`);
  }
  const inKillScores = await db.collection('pnthr_kill_scores').findOne({ ticker: TICKER }, { sort: { weekOf: -1 } });
  console.log(`   pnthr_kill_scores latest:  ${inKillScores ? `weekOf=${inKillScores.weekOf} signal=${inKillScores.signal} score=${inKillScores.totalScore}` : 'NOT FOUND'}`);
  const inIndex = await db.collection('pnthr_index_membership_current').findOne({ ticker: TICKER });
  console.log(`   pnthr_index_membership:    ${inIndex ? `${inIndex.indexes?.join(',') || 'present'}` : 'NOT FOUND'}`);
  const inSectorCache = await db.collection('pnthr_ticker_sector_cache').findOne({ ticker: TICKER });
  console.log(`   pnthr_ticker_sector_cache: ${inSectorCache ? `sector=${inSectorCache.sector}` : 'NOT FOUND'}`);
}

// ── Probe 4: signalService.getSignals ──────────────────────────────────────
console.log('\n─── 4. signalService.getSignals (live call) ─────────────────────');
const sectorMap = profile?.sector ? { [TICKER]: profile.sector } : {};
const result = await getSignals([TICKER], { sectorMap });
const sig = result[TICKER] || {};
console.log(`   signal:    ${sig.signal ?? 'null'}`);
console.log(`   ema21:     ${sig.ema21 ?? 'null'}`);
console.log(`   stopPrice: ${sig.stopPrice ?? sig.pnthrStop ?? 'null'}`);
console.log(`   emaPeriod: ${sig.emaPeriod ?? 'null'}`);

// ── Probe 5: Common ticker variations ──────────────────────────────────────
console.log('\n─── 5. Ticker variations ────────────────────────────────────────');
for (const variant of ['XE.TO', 'XE.V', 'XEC', 'XEC.TO']) {
  try {
    const r = await fetch(
      `https://financialmodelingprep.com/api/v3/profile/${variant}?apikey=${FMP_KEY}`
    );
    const data = await r.json();
    if (Array.isArray(data) && data.length > 0) {
      console.log(`   ${variant.padEnd(10)} → FOUND  ${data[0].companyName} (${data[0].exchange})`);
    } else {
      console.log(`   ${variant.padEnd(10)} → empty`);
    }
  } catch { console.log(`   ${variant.padEnd(10)} → fetch failed`); }
}

// ── Verdict ─────────────────────────────────────────────────────────────────
console.log('\n─── VERDICT ─────────────────────────────────────────────────────');
const profileFound = !!profile;
const hasEnoughBars = barCount >= 23 * 5; // need 23+ weekly bars
const sigComputed = sig.ema21 != null;

if (!profileFound && barCount === 0) {
  console.log('   ✗ XE has NO data in FMP under this ticker. Either:');
  console.log('     (a) The IBKR symbol is a different exchange (TSX, AMEX, etc.) and');
  console.log('         FMP only covers the US listing, OR');
  console.log('     (b) XE is a recently-listed/recently-delisted ticker outside FMP coverage.');
  console.log('   → Manual entry via AddPositionModal is the correct path.');
} else if (profileFound && !hasEnoughBars) {
  console.log('   ⚠ XE has FMP profile but insufficient historical bars for state machine.');
  console.log('   → Likely a young IPO; manual entry is the correct path.');
} else if (sigComputed && (sig.signal == null || (sig.stopPrice ?? sig.pnthrStop) == null)) {
  console.log('   ⚠ XE has bars + EMA but no active signal AND no stop.');
  console.log('   → State machine ran but found no entry/exit event. Manual entry per signal=SE pattern.');
} else if (sigComputed) {
  console.log('   ⚠ Unexpected — signalService produced a stop, but Phase 3 didn\'t use it.');
  console.log('   → Investigate ibkrSync.processNewPositions sector lookup path.');
} else {
  console.log('   ⚠ Mixed picture. Review the per-probe output above.');
}

console.log('');
process.exit(0);
