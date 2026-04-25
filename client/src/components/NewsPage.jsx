import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../AuthContext';
import { marked } from 'marked';
import styles from './NewsPage.module.css';
import pnthrLogo from '../assets/panther head.png';
const scottAvatar = '/scott-pnthr-transparent.png';
import ChartModal from './ChartModal';
import {
  fetchNewsletterList,
  fetchNewsletterIssue,
  generateNewsletterIssue,
  saveNewsletterDraft,
  publishNewsletterIssue,
  fetchJungleStocks,
  fetchEarnings,
  fetchStockSearch,
} from '../services/api';

marked.setOptions({ breaks: true });

// Parse the Trade of the Week ticker from the narrative markdown.
// Strategy 1: > **TICKER — Company Name**  (blockquote trigger line)
// Strategy 2: ## ... Trade of the Week — TICKER  (from heading itself)
// Strategy 3: ## ... Trade of the Week — TICKER (Company Name)
function extractTotwTicker(narrative) {
  if (!narrative) return null;
  // Blockquote line: > **DAR — ...
  const bqMatch = narrative.match(/>\s*\*\*([A-Z]{1,5})\s*[—–-]/);
  if (bqMatch) return bqMatch[1];
  // Heading line: ## ... Trade of the Week — DAR ...
  const hdgMatch = narrative.match(/##[^\n]*Trade of the Week[^\n]*[—–-]\s*([A-Z]{2,5})\b/i);
  if (hdgMatch) return hdgMatch[1];
  return null;
}

function formatWeekOf(isoDate) {
  if (!isoDate) return '';
  return new Date(isoDate + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function StatusBadge({ status }) {
  return (
    <span className={status === 'published' ? styles.badgePublished : styles.badgeDraft}>
      {status === 'published' ? 'Published' : 'Draft'}
    </span>
  );
}

export default function NewsPage() {
  const { isAdmin } = useAuth();
  const [issues, setIssues]           = useState([]);
  const [selectedId, setSelectedId]   = useState(null);
  const [issue, setIssue]             = useState(null);
  const [listLoading, setListLoading] = useState(true);
  const [issueLoading, setIssueLoading] = useState(false);
  const [generating, setGenerating]   = useState(false);
  const [saving, setSaving]           = useState(false);
  const [publishing, setPublishing]   = useState(false);
  const [editMode, setEditMode]       = useState(false);
  const [draftText, setDraftText]     = useState('');
  const [error, setError]             = useState(null);
  const [genError, setGenError]       = useState(null);

  // Jungle stocks + earnings — loaded silently for chart linking
  const [jungleStocks, setJungleStocks]   = useState([]);
  const [jungleEarnings, setJungleEarnings] = useState({});
  const [chartIndex, setChartIndex]       = useState(null);
  const [chartStocks, setChartStocks]     = useState([]);

  // Load issue list
  const loadList = useCallback(async () => {
    try {
      setListLoading(true);
      const data = await fetchNewsletterList();
      setIssues(data);
      // Auto-select most recent
      if (data.length > 0 && !selectedId) {
        setSelectedId(data[0]._id);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setListLoading(false);
    }
  }, [selectedId]);

  useEffect(() => { loadList(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Silently pre-load jungle stocks so tickers in the newsletter are clickable
  useEffect(() => {
    fetchJungleStocks()
      .then(data => {
        const stockList = data.stocks || [];
        setJungleStocks(stockList);
        fetchEarnings(stockList.map(s => s.ticker)).then(setJungleEarnings);
      })
      .catch(err => console.warn('Chart pre-load skipped:', err));
  }, []);

  // Load selected issue
  useEffect(() => {
    if (!selectedId) return;
    setIssueLoading(true);
    setEditMode(false);
    setError(null);
    fetchNewsletterIssue(selectedId)
      .then(data => {
        setIssue(data);
        setDraftText(data.narrative || '');
      })
      .catch(err => setError(err.message))
      .finally(() => setIssueLoading(false));
  }, [selectedId]);

  async function handleGenerate() {
    setGenerating(true);
    setGenError(null);
    try {
      const newIssue = await generateNewsletterIssue();
      await loadList();
      setSelectedId(newIssue._id?.toString() || newIssue._id);
    } catch (err) {
      setGenError(err.message);
    } finally {
      setGenerating(false);
    }
  }

  async function handleSave() {
    if (!issue) return;
    setSaving(true);
    try {
      await saveNewsletterDraft(issue._id, draftText);
      setIssue(prev => ({ ...prev, narrative: draftText }));
      setEditMode(false);
    } catch (err) {
      alert('Save failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handlePublish() {
    if (!issue) return;
    if (!window.confirm('Publish this issue? It will be visible to subscribers.')) return;
    setPublishing(true);
    try {
      await publishNewsletterIssue(issue._id);
      setIssue(prev => ({ ...prev, status: 'published' }));
      setIssues(prev => prev.map(i =>
        i._id === issue._id ? { ...i, status: 'published' } : i
      ));
    } catch (err) {
      alert('Publish failed: ' + err.message);
    } finally {
      setPublishing(false);
    }
  }

  const rawHtml = issue?.narrative ? marked.parse(issue.narrative) : '';

  // Build the sector-rotation chart HTML (week-over-week long-lean %).
  // Data comes from issue.charts.sectorRotation (computed server-side at
  // generation time). Yellow bar = this week, gray bar = last week. If
  // there's no prior-issue data the gray bar renders with width 0 and the
  // delta label is suppressed.
  const sectorRotationChartHtml = useMemo(() => {
    const rows = issue?.charts?.sectorRotation || [];
    if (!rows.length) return '';
    const items = rows.map(r => {
      const lastWeekWidth = r.lastWeek == null ? 0 : r.lastWeek;
      const deltaLabel = r.delta == null ? ''
        : r.delta > 0 ? `▲${r.delta}`
        : r.delta < 0 ? `▼${Math.abs(r.delta)}`
        :               '—';
      const deltaClass = r.delta == null ? ''
        : r.delta > 0 ? 'pnthr-chart-delta-up'
        : r.delta < 0 ? 'pnthr-chart-delta-down'
        :               'pnthr-chart-delta-flat';
      return `
        <div class="pnthr-chart-row">
          <div class="pnthr-chart-label">${r.sector}</div>
          <div class="pnthr-chart-track">
            <div class="pnthr-chart-bar pnthr-chart-bar-lastweek" style="width:${lastWeekWidth}%"></div>
            <div class="pnthr-chart-bar pnthr-chart-bar-thisweek" style="width:${r.thisWeek}%"></div>
          </div>
          <div class="pnthr-chart-vals">
            <span class="pnthr-chart-val-thisweek">${r.thisWeek}%</span>
            ${deltaLabel ? `<span class="pnthr-chart-val-delta ${deltaClass}">${deltaLabel}</span>` : ''}
          </div>
        </div>
      `;
    }).join('');
    return `
      <div class="pnthr-chart-panel">
        <div class="pnthr-chart-title">SECTOR LONG-LEAN % — THIS WEEK VS LAST WEEK</div>
        <div class="pnthr-chart-legend">
          <span class="pnthr-chart-legend-item"><span class="pnthr-chart-legend-dot pnthr-chart-legend-thisweek"></span>This week</span>
          <span class="pnthr-chart-legend-item"><span class="pnthr-chart-legend-dot pnthr-chart-legend-lastweek"></span>Last week</span>
        </div>
        <div class="pnthr-chart-bars">${items}</div>
      </div>
    `;
  }, [issue?.charts?.sectorRotation]);

  // Known tickers set — built once jungle stocks load
  const knownTickers = useMemo(() => new Set(jungleStocks.map(s => s.ticker)), [jungleStocks]);

  // Wrap known ticker symbols in clickable spans (only in text nodes, not inside HTML tags)
  // Also inject a View Chart button next to the Trade of the Week heading.
  // NOTE: button injection is independent of jungle stocks so it always shows immediately.
  const renderedHtml = useMemo(() => {
    if (!rawHtml) return rawHtml;
    const totwTicker = extractTotwTicker(issue?.narrative);

    // Strip panther emoji and replace em-dashes with regular dashes throughout
    let html = rawHtml;
    html = html.replace(/🐆\s*/g, '');
    html = html.replace(/—/g, ' - ');

    // Inject TOTW hero card BEFORE ticker linkification so the h2 regex
    // matches clean text (linkification would inject <span> tags inside h2,
    // breaking the [^<]* pattern and causing the card to fall to the bottom).
    if (totwTicker) {
      const card =
        `<div class="pnthr-totw-hero">` +
          `<div class="pnthr-totw-hero-left">` +
            `<img src="${pnthrLogo}" class="pnthr-totw-logo-img" alt="PNTHR" />` +
            `<div>` +
              `<div class="pnthr-totw-hero-label">PNTHR TRADE OF THE WEEK</div>` +
              `<div class="pnthr-totw-hero-ticker">${totwTicker}</div>` +
            `</div>` +
          `</div>` +
          `<button class="pnthr-totw-btn" data-totw-chart="${totwTicker}">▶ VIEW CHART</button>` +
        `</div>`;
      // Replace the TOTW h2 with the hero card + hidden h2.
      // [^<]*? keeps the match inside ONE h2 — earlier [\s\S]*? greedily spanned
      // from the first h2 on the page through the real TOTW h2, placing the
      // card at the very top and leaving the real TOTW heading visible.
      const replaced = html.replace(
        /(<h2[^>]*>)([^<]*?Trade of the Week[^<]*?)(<\/h2>)/i,
        `${card}<h2 class="pnthr-totw-heading">$2$3`
      );
      html = replaced !== html ? replaced : html + card;

      // Enrich the TOTW callout blockquote with direction + profit lines if
      // Claude only rendered the first line. featuredTrade is the structured
      // record the backend built from the live signal; we rebuild the two
      // missing lines from it so the callout matches the visual contract.
      const ft = issue?.featuredTrade;
      if (ft && ft.profitDollar != null && ft.profitPct != null) {
        const direction = ft.direction === 'short' ? 'Short cover' : 'Long exit';
        const dollars   = Math.abs(Number(ft.profitDollar)).toFixed(2);
        const pct       = Math.abs(Number(ft.profitPct)).toFixed(2);
        html = html.replace(
          /(<blockquote>\s*<p>[\s\S]*?<\/p>\s*<\/blockquote>)/i,
          (match) => {
            if (/Profit:|trade closed profitably/i.test(match)) return match;
            const inject = `<br>${direction} (trade closed profitably)<br><strong>Profit: +$${dollars} (+${pct}%)</strong>`;
            // Use a function callback so the `$` chars in the dollar amount
            // aren't interpreted as regex backreferences (e.g. `$21.64` was
            // becoming `1.64` because `$2` was treated as capture group 2).
            return match.replace(/<\/p>/, () => `${inject}</p>`);
          }
        );
      }

      // Reorder: move the whole TOTW block (hero card + hidden heading +
      // blockquote + paragraphs) to sit between THE OPENING section and the
      // next section, so the reader hits the trade story before the sector
      // rotation deep-dive. The block is bounded by <hr>/next non-TOTW <h2>.
      const totwBlockRe = /<div class="pnthr-totw-hero">[\s\S]*?(?=<hr\b|<h2(?![^>]*pnthr-totw-heading))/;
      const totwMatch   = html.match(totwBlockRe);
      if (totwMatch) {
        const totwBlock = totwMatch[0];
        const without = html
          .replace(totwBlockRe, '')
          // Collapse the now-adjacent <hr><hr> left behind when TOTW was cut
          .replace(/(<hr\b[^>]*>)\s*<hr\b[^>]*>/g, '$1');
        // Function callback so any `$N` inside totwBlock (e.g. the dollar
        // amount in "+$21.64") isn't interpreted as a regex backreference.
        // String-form replacement was injecting the second capture group's
        // <hr> in the middle of the profit number, splitting "+$21.64" into
        // "+ <hr> 1.64" and breaking the rendered profit line.
        const inserted = without.replace(
          /(<h2(?![^>]*pnthr-totw-heading)[^>]*>[\s\S]*?)(<hr\b[^>]*>|<h2(?![^>]*pnthr-totw-heading))/,
          (_m, p1, p2) => `${p1}${totwBlock}${p2}`
        );
        if (inserted !== without) html = inserted;
      }
    }

    // Inject the sector-rotation chart at the END of the rotation section
    // (right before the next h2 heading, so it reads as a 'here's what we
    // just described, visualized' summary). perchService.js uses
    // '## SECTOR ROTATION' as the section heading; the older
    // newsletterService.js path uses '## Sector Intelligence'. Match either.
    // Done before ticker linkification so the chart HTML isn't touched by
    // the ticker-link regex.
    if (sectorRotationChartHtml) {
      const sectorRegex = /(<h2[^>]*>[^<]*(?:Sector Rotation|Sector Intelligence)[^<]*<\/h2>)([\s\S]*?)(?=<h2|$)/i;
      if (sectorRegex.test(html)) {
        html = html.replace(sectorRegex, (_m, heading, body) => `${heading}${body}${sectorRotationChartHtml}`);
      } else {
        // Fallback: if no matching section heading exists, append the chart
        // at the end so the user still sees it.
        html = html + sectorRotationChartHtml;
      }
    }

    // Linkify tickers only once jungle stocks are loaded
    if (knownTickers.size > 0) {
      html = html.replace(/(?<=>|^)([^<]+)(?=<|$)/g, textBlock =>
        textBlock.replace(/\b([A-Z]{2,5})\b/g, word =>
          knownTickers.has(word)
            ? `<span class="pnthr-ticker-link" data-ticker="${word}">${word}</span>`
            : word
        )
      );
    }

    return html;
  }, [rawHtml, knownTickers, issue?.narrative, issue?.featuredTrade, sectorRotationChartHtml]);

  async function handleArticleClick(e) {
    const ticker = e.target.dataset?.ticker || e.target.dataset?.totwChart;
    if (!ticker) return;
    const idx = jungleStocks.findIndex(s => s.ticker === ticker);
    if (idx !== -1) {
      // Jungle stocks already loaded — use full list for prev/next navigation
      setChartStocks(jungleStocks);
      setChartIndex(idx);
    } else {
      // Jungle stocks not loaded yet (cold server) — fetch this single ticker
      try {
        const result = await fetchStockSearch(ticker);
        if (result?.stock) {
          setChartStocks([result.stock]);
          setChartIndex(0);
        }
      } catch (err) {
        console.warn('Single-stock chart fallback failed:', err);
      }
    }
  }

  return (
    <div className={styles.page}>

      {/* ── Header ── */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <img src={pnthrLogo} alt="PNTHR" className={styles.headerLogo} />
          <div className={styles.headerText}>
            <h1 className={styles.headerTitle}>PNTHR'S PERCH</h1>
            <p className={styles.headerSub}>Weekly Market Intelligence · The PNTHR surveys the jungle from above. Nothing gets past The PNTHR! ...Legend.</p>
          </div>
        </div>
        {isAdmin && (
          <button
            className={styles.generateBtn}
            onClick={handleGenerate}
            disabled={generating}
          >
            {generating ? '⏳ Generating...' : '+ Generate This Week'}
          </button>
        )}
      </div>

      {genError && <div className={styles.genError}>Generation failed: {genError}</div>}

      {/* ── Body ── */}
      <div className={styles.body}>

        {/* ── Issue List Sidebar ── */}
        <aside className={styles.sidebar}>
          <div className={styles.sidebarTitle}>Archive</div>
          {listLoading ? (
            <div className={styles.sidebarEmpty}>Loading...</div>
          ) : issues.length === 0 ? (
            <div className={styles.sidebarEmpty}>No issues yet.<br />Generate the first one.</div>
          ) : (
            <ul className={styles.issueList}>
              {issues.map(iss => (
                <li key={iss._id} className={styles.issueItem}>
                  <button
                    className={`${styles.issueBtn} ${selectedId === iss._id ? styles.issueBtnActive : ''}`}
                    onClick={() => setSelectedId(iss._id)}
                  >
                    <span className={styles.issueDate}>{formatWeekOf(iss.weekOf)}</span>
                    <StatusBadge status={iss.status} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* ── Article Area ── */}
        <main className={styles.article}>
          {issueLoading && (
            <div className={styles.loadingState}>
              <div className={styles.spinner} />
              <p>Loading issue...</p>
            </div>
          )}

          {!issueLoading && !issue && !error && (
            <div className={styles.emptyState}>
              <img src={pnthrLogo} alt="PNTHR" className={styles.emptyLogo} />
              <p className={styles.emptyText}>
                {isAdmin
                  ? <>Select an issue from the archive,<br />or generate this week's Perch.</>
                  : <>Select an issue from the archive<br />to read this week's intelligence.</>}
              </p>
            </div>
          )}

          {error && <div className={styles.errorState}>Error: {error}</div>}

          {!issueLoading && issue && (
            <>
              {/* Controls */}
              <div className={styles.controls}>
                <div className={styles.controlsLeft}>
                  <span className={styles.issueWeek}>Week of {formatWeekOf(issue.weekOf)}</span>
                  <StatusBadge status={issue.status} />
                  {issue.generatedAt && (
                    <span className={styles.metaNote}>
                      Generated {new Date(issue.generatedAt).toLocaleString()}
                    </span>
                  )}
                </div>
                <div className={styles.controlsRight}>
                  {isAdmin && (!editMode ? (
                    <button className={styles.editBtn} onClick={() => setEditMode(true)}>Edit</button>
                  ) : (
                    <>
                      <button className={styles.cancelBtn} onClick={() => { setEditMode(false); setDraftText(issue.narrative); }}>Cancel</button>
                      <button className={styles.saveBtn} onClick={handleSave} disabled={saving}>
                        {saving ? 'Saving...' : 'Save Draft'}
                      </button>
                    </>
                  ))}
                  {isAdmin && issue.status !== 'published' && !editMode && (
                    <button className={styles.publishBtn} onClick={handlePublish} disabled={publishing}>
                      {publishing ? 'Publishing...' : 'Publish'}
                    </button>
                  )}
                </div>
              </div>

              {/* Edit mode */}
              {editMode ? (
                <textarea
                  className={styles.editor}
                  value={draftText}
                  onChange={e => setDraftText(e.target.value)}
                />
              ) : (
                <>
                  {/* Article masthead — author avatar + title + date */}
                  <div className={styles.articleMasthead}>
                    <img src={scottAvatar} alt="Scott McBrien" className={styles.mastheadAvatar} />
                    <div className={styles.mastheadTitle}>PNTHR'S PERCH</div>
                    <div className={styles.mastheadSub}>Weekly Market Intelligence</div>
                    <div className={styles.mastheadDate}>Week of {formatWeekOf(issue.weekOf)}</div>
                    <div className={styles.mastheadAuthor}>by Scott McBrien</div>
                  </div>
                  <div className={styles.mastheadDivider} />

                  {/* Rendered article — tickers are clickable spans */}
                  <article
                    className={styles.articleBody}
                    dangerouslySetInnerHTML={{ __html: renderedHtml }}
                    onClick={handleArticleClick}
                  />
                </>
              )}
            </>
          )}
        </main>
      </div>

      {chartIndex != null && (
        <ChartModal
          stocks={chartStocks}
          initialIndex={chartIndex}
          earnings={jungleEarnings}
          onClose={() => setChartIndex(null)}
        />
      )}
    </div>
  );
}
