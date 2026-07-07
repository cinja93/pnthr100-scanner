// PNTHR Accounting — IBKR Flex Web Service ingestion (Bucket A: the custodian truth).
//
// Pulls the fund's Interactive Brokers Activity Flex Query (positions, tax lots,
// realized/unrealized P&L, commissions, interest, dividends, cash) via the official
// two-step Flex Web Service, and stores the parsed statement keyed by month. This is
// the penny-exact source that the accounting engine reconciles against.
//
// Flow (IBKR Flex Web Service v3, verified against IBKR docs 2026-06):
//   1. SendRequest?t=TOKEN&q=QUERYID&v=3  -> <FlexStatementResponse> with a ReferenceCode
//   2. GetStatement?t=TOKEN&q=REFCODE&v=3 -> the <FlexQueryResponse> statement, OR a
//      <FlexStatementResponse> Warn/ErrorCode=1019 ("generation in progress") -> poll/retry
//
// The XML INTERPRETATION is factored into pure functions (interpretSendResponse /
// interpretGetResponse / parseFlexStatement) so it is unit-testable without a live token.
// The live field-level mapping into engine inputs is finalized against a real statement
// once the token + Query ID exist (no guessing field names off a spec).

import { XMLParser } from 'fast-xml-parser';
import { connectToDatabase } from './database.js';

const SEND_URL = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest';
const GET_URL  = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement';
const VERSION = 3;
const RAW_COLLECTION = 'pnthr_acct_ibkr_raw';

// Keep everything as STRINGS — never let an XML parser coerce money to a float and lose
// precision. The engine converts explicitly, with care, downstream.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

// ── Pure interpreters (no network) ─────────────────────────────────────────────

// Parse a SendRequest response. Returns { referenceCode, url } on success, else throws
// an Error carrying the IBKR error code + message.
export function interpretSendResponse(xml) {
  const doc = parser.parse(xml);
  const r = doc?.FlexStatementResponse;
  if (!r) throw new Error(`Unexpected SendRequest response: ${String(xml).slice(0, 200)}`);
  if (String(r.Status) === 'Success') {
    const referenceCode = String(r.ReferenceCode);
    const url = r.Url ? String(r.Url) : GET_URL;
    if (!referenceCode || referenceCode === 'undefined') throw new Error('SendRequest succeeded but no ReferenceCode returned');
    return { referenceCode, url };
  }
  const err = new Error(`IBKR Flex SendRequest failed: [${r.ErrorCode ?? '?'}] ${r.ErrorMessage ?? 'unknown error'}`);
  err.code = r.ErrorCode != null ? String(r.ErrorCode) : null;
  throw err;
}

// Parse a GetStatement response. Three outcomes:
//   { ready:true, statement }              -> the FlexQueryResponse statement object
//   { ready:false, retry:true, code, msg } -> still generating (code 1019 / Status Warn)
//   throws                                  -> a real error (expired token, bad query, etc.)
export function interpretGetResponse(xml) {
  const doc = parser.parse(xml);
  if (doc?.FlexQueryResponse) {
    return { ready: true, statement: doc.FlexQueryResponse };
  }
  const r = doc?.FlexStatementResponse;
  if (r) {
    const code = r.ErrorCode != null ? String(r.ErrorCode) : null;
    const status = String(r.Status ?? '');
    // 1019 = "Statement generation in progress" -> retry. Status Warn is also transient.
    if (code === '1019' || status === 'Warn') {
      return { ready: false, retry: true, code, msg: r.ErrorMessage ? String(r.ErrorMessage) : 'generation in progress' };
    }
    const err = new Error(`IBKR Flex GetStatement failed: [${code ?? '?'}] ${r.ErrorMessage ?? 'unknown error'}`);
    err.code = code;
    throw err;
  }
  throw new Error(`Unexpected GetStatement response: ${String(xml).slice(0, 200)}`);
}

// Normalize a parsed FlexQueryResponse into a flatter shape the engine can consume.
// Defensive: tolerates single-vs-array (fast-xml-parser collapses a 1-element list to an
// object) and missing sections. Field-level mapping is finalized against a real statement.
export function parseFlexStatement(flexQueryResponse) {
  const stmtNode = flexQueryResponse?.FlexStatements?.FlexStatement;
  const stmt = Array.isArray(stmtNode) ? stmtNode[0] : stmtNode;
  if (!stmt) return { accountId: null, fromDate: null, toDate: null, sections: {} };

  // Each section (OpenPositions, Trades, etc.) wraps rows in a child element; collect
  // the row arrays generically so we don't hard-code/guess every field now.
  const sections = {};
  for (const [key, val] of Object.entries(stmt)) {
    if (key === 'accountId' || key === 'fromDate' || key === 'toDate' || key === 'period' || key === 'whenGenerated') continue;
    if (val && typeof val === 'object') {
      // Leaf element whose data IS its own attributes (e.g. ChangeInNAV) — the element is the row.
      const vals = Object.values(val);
      if (vals.length && vals.every(v => v == null || typeof v !== 'object')) {
        sections[key] = [val];
      } else {
        // Wrapper like { OpenPosition: [...] } — grab the first object/array child as the rows.
        const childKey = Object.keys(val).find(k => k !== 'count' && typeof val[k] === 'object');
        if (childKey) {
          const rows = val[childKey];
          sections[key] = Array.isArray(rows) ? rows : (rows ? [rows] : []);
        } else {
          sections[key] = [];
        }
      }
    }
  }

  // ADDITIVE: some wrappers hold MULTIPLE row-bearing children (e.g. <Trades> wraps Trade, Lot,
  // WashSale, Order, SymbolSummary). The loop above keeps only the first child under the container
  // key — fine for the single-child sections the close/Trial-Balance path reads, but it drops the
  // trade/tax-lot detail Doc 4 needs. Expose each such child under its own element name WITHOUT
  // touching any key already set above (never overwrite a working section).
  for (const val of Object.values(stmt)) {
    if (!val || typeof val !== 'object') continue;
    const childKeys = Object.keys(val).filter(k => k !== 'count' && val[k] && typeof val[k] === 'object');
    if (childKeys.length < 2) continue;   // single-child wrappers already handled above
    for (const ck of childKeys) {
      if (sections[ck] != null) continue; // never clobber an existing section
      const rows = val[ck];
      sections[ck] = Array.isArray(rows) ? rows : [rows];
    }
  }

  return {
    accountId: stmt.accountId ? String(stmt.accountId) : null,
    fromDate: stmt.fromDate ? String(stmt.fromDate) : null,
    toDate: stmt.toDate ? String(stmt.toDate) : null,
    whenGenerated: stmt.whenGenerated ? String(stmt.whenGenerated) : null,
    sections,
  };
}

// A short summary for logging / verification (counts per section).
export function summarizeFlex(parsed) {
  const out = { accountId: parsed.accountId, fromDate: parsed.fromDate, toDate: parsed.toDate, counts: {} };
  for (const [k, rows] of Object.entries(parsed.sections || {})) {
    out.counts[k] = Array.isArray(rows) ? rows.length : 0;
  }
  return out;
}

// ── Network layer ──────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

async function httpGetText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'PNTHR-Accounting/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from Flex Web Service`);
  return res.text();
}

// Step 1: request the statement, get a reference code.
export async function sendFlexRequest(token, queryId) {
  const xml = await httpGetText(`${SEND_URL}?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=${VERSION}`);
  return interpretSendResponse(xml);
}

// Step 2: poll for the statement until ready (handles code 1019).
export async function getFlexStatement(token, referenceCode, baseUrl = GET_URL, { retries = 12, delayMs = 5000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const xml = await httpGetText(`${baseUrl}?t=${encodeURIComponent(token)}&q=${encodeURIComponent(referenceCode)}&v=${VERSION}`);
    const result = interpretGetResponse(xml);
    if (result.ready) return { xml, statement: result.statement };
    if (!result.retry) throw new Error(`Flex statement not retrievable: [${result.code}] ${result.msg}`);
    if (attempt < retries) await sleep(delayMs);
  }
  throw new Error(`IBKR Flex statement still not ready after ${retries} retries`);
}

// Full pull: send -> poll -> parse. Tries the primary Query ID, then any configured
// fallback if the primary is unavailable (IBKR code 1014 — a freshly created/edited query
// can take 15-60 min to activate on the Web Service even though it is valid in the UI).
// This keeps the monthly close from ever failing on an IBKR propagation hiccup, and it
// auto-upgrades to the primary the moment it serves. Real errors (expired token, etc.)
// are NOT swallowed — only 1014 triggers the fallback.
// IBKR Flex transient/throttle error codes that should be RETRIED with backoff
// rather than failing the monthly close. 1025 = too many requests (rate limit —
// the exact code that silently killed a close per the 2026-07-06 audit); 1018/1020
// are IBKR-side "try again" conditions. A close missing entirely on a regulated fund
// is worse than waiting a few minutes.
const FLEX_TRANSIENT_CODES = new Set(['1025', '1018', '1020']);

export async function pullFlexStatement({ token, queryId, retries, delayMs, throttleRetries = 5, throttleBaseMs = 20000 } = {}) {
  const t = token || process.env.IBKR_FLEX_TOKEN;
  const primary = queryId || process.env.IBKR_FLEX_QUERY_ID;
  const fallback = process.env.IBKR_FLEX_QUERY_ID_FALLBACK;
  if (!t) throw new Error('IBKR Flex token missing (pass token or set IBKR_FLEX_TOKEN)');
  if (!primary) throw new Error('IBKR Flex Query ID missing (pass queryId or set IBKR_FLEX_QUERY_ID)');
  const queue = [primary];
  if (fallback && fallback !== primary) queue.push(fallback);
  let lastErr;
  for (let i = 0; i < queue.length; i++) {
    const q = queue[i];
    // Throttle-retry loop around this query: a 1025/transient code backs off and
    // retries the SAME query (exponential: 20s, 40s, 80s, ...) before giving up.
    for (let attempt = 0; attempt <= throttleRetries; attempt++) {
      try {
        const { referenceCode, url } = await sendFlexRequest(t, q);
        const { xml, statement } = await getFlexStatement(t, referenceCode, url, { retries, delayMs });
        const parsed = parseFlexStatement(statement);
        return { xml, parsed, summary: summarizeFlex(parsed), queryIdUsed: q, usedFallback: i > 0, throttleAttempts: attempt };
      } catch (e) {
        lastErr = e;
        if (FLEX_TRANSIENT_CODES.has(String(e.code)) && attempt < throttleRetries) {
          const wait = throttleBaseMs * Math.pow(2, attempt);
          console.warn(`[IBKR Flex] query ${q} throttled ([${e.code}] ${e.message}); retry ${attempt + 1}/${throttleRetries} in ${wait / 1000}s`);
          await sleep(wait);
          continue;
        }
        break;   // non-transient, or throttle retries exhausted → try fallback query (or rethrow)
      }
    }
    if (lastErr && lastErr.code === '1014' && i < queue.length - 1) {
      console.warn(`[IBKR Flex] query ${q} unavailable (1014 — not yet active); falling back to ${queue[i + 1]}`);
      continue;
    }
    if (lastErr && FLEX_TRANSIENT_CODES.has(String(lastErr.code)) && i < queue.length - 1) continue;   // throttled out on primary → try fallback
    if (lastErr && lastErr.code !== '1014' && !FLEX_TRANSIENT_CODES.has(String(lastErr.code))) throw lastErr;
  }
  throw lastErr;
}

// Pull + store the raw statement for a given accounting period (e.g. "2026-04").
// `period` is the storage key the caller asserts this statement covers; the actual
// date range is governed by the Flex Query's saved period setting (verified via toDate).
export async function ingestFlexForPeriod({ token, queryId, period, generatedBy = 'manual' } = {}) {
  if (!period) throw new Error('period is required (e.g. "2026-04")');
  const { xml, parsed, summary } = await pullFlexStatement({ token, queryId });

  const db = await connectToDatabase();
  if (!db) throw new Error('Database unavailable');
  try { await db.collection(RAW_COLLECTION).createIndex({ period: 1 }, { unique: true }); } catch { /* exists */ }

  const now = new Date();
  await db.collection(RAW_COLLECTION).updateOne(
    { period },
    {
      $set: {
        period,
        queryId: queryId || process.env.IBKR_FLEX_QUERY_ID || null,
        accountId: parsed.accountId,
        fromDate: parsed.fromDate,
        toDate: parsed.toDate,
        summary,
        parsed,
        xml,
        generatedBy,
        fetchedAt: now,
      },
    },
    { upsert: true },
  );
  return summary;
}

// ── CLI: `node pnthrAccountingIbkrFlex.js <period>` (token+queryId from env) ──────
// Used for the first live verification + by the monthly cron later.
import path from 'path';
import { fileURLToPath } from 'url';
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const period = process.argv[2];
  if (!period) { console.error('Usage: node pnthrAccountingIbkrFlex.js <YYYY-MM>'); process.exit(1); }
  ingestFlexForPeriod({ period, generatedBy: 'cli' })
    .then(summary => { console.log('[IBKR Flex] ingested', period, JSON.stringify(summary, null, 2)); process.exit(0); })
    .catch(err => { console.error('[IBKR Flex] FAILED:', err.message); process.exit(1); });
}
