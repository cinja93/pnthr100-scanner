import { useState, useEffect, useCallback, useMemo } from 'react';
import { marked } from 'marked';
import styles from './NewsPage.module.css';
import pnthrLogo from '../assets/panther head.png';
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

export default function NewsPage({ currentUser }) {
  const isAdmin = currentUser?.role === 'admin';
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

  // Known tickers set — built once jungle stocks load
  const knownTickers = useMemo(() => new Set(jungleStocks.map(s => s.ticker)), [jungleStocks]);

  // Wrap known ticker symbols in clickable spans (only in text nodes, not inside HTML tags)
  // Also inject a View Chart button next to the Trade of the Week heading.
  // NOTE: button injection is independent of jungle stocks so it always shows immediately.
  const renderedHtml = useMemo(() => {
    if (!rawHtml) return rawHtml;
    const totwTicker = extractTotwTicker(issue?.narrative);

    // Linkify tickers only once jungle stocks are loaded
    let html = rawHtml;
    if (knownTickers.size > 0) {
      html = html.replace(/(?<=>|^)([^<]+)(?=<|$)/g, textBlock =>
        textBlock.replace(/\b([A-Z]{2,5})\b/g, word =>
          knownTickers.has(word)
            ? `<span class="pnthr-ticker-link" data-ticker="${word}">${word}</span>`
            : word
        )
      );
    }

    // Always inject TOTW button as a prominent block after the Trade of the Week heading
    if (totwTicker) {
      const btnBlock = `<div class="pnthr-totw-btnwrap"><button class="pnthr-totw-btn" data-totw-chart="${totwTicker}">📈 View ${totwTicker} Chart</button></div>`;
      const replaced = html.replace(
        /(<h2[^>]*>[^<]*Trade of the Week[^<]*<\/h2>)/i,
        `$1${btnBlock}`
      );
      // Fallback: if h2 pattern didn't match, append button at end of article
      html = replaced !== html ? replaced : html + btnBlock;
    }
    return html;
  }, [rawHtml, knownTickers, issue?.narrative]);

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
              <p className={styles.emptyText}>Select an issue from the archive,<br />or generate this week's Perch.</p>
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
                  {/* Article masthead — logo + title + date */}
                  <div className={styles.articleMasthead}>
                    <img src={pnthrLogo} alt="PNTHR" className={styles.mastheadLogo} />
                    <div className={styles.mastheadTitle}>PNTHR'S PERCH</div>
                    <div className={styles.mastheadSub}>Weekly Market Intelligence</div>
                    <div className={styles.mastheadDate}>Week of {formatWeekOf(issue.weekOf)}</div>
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
