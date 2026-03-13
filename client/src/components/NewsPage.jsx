import { useState, useEffect, useCallback } from 'react';
import { marked } from 'marked';
import styles from './NewsPage.module.css';
import pnthrLogo from '../assets/panther head.png';
import {
  fetchNewsletterList,
  fetchNewsletterIssue,
  generateNewsletterIssue,
  saveNewsletterDraft,
  publishNewsletterIssue,
} from '../services/api';

marked.setOptions({ breaks: true });

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

  const renderedHtml = issue?.narrative
    ? marked.parse(issue.narrative)
    : '';

  return (
    <div className={styles.page}>

      {/* ── Header ── */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <img src={pnthrLogo} alt="PNTHR" className={styles.headerLogo} />
          <div className={styles.headerText}>
            <h1 className={styles.headerTitle}>PNTHR'S PERCH</h1>
            <p className={styles.headerSub}>Weekly Market Intelligence · The panther surveys the jungle from above</p>
          </div>
        </div>
        <button
          className={styles.generateBtn}
          onClick={handleGenerate}
          disabled={generating}
        >
          {generating ? '⏳ Generating...' : '+ Generate This Week'}
        </button>
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
                  {!editMode ? (
                    <button className={styles.editBtn} onClick={() => setEditMode(true)}>Edit</button>
                  ) : (
                    <>
                      <button className={styles.cancelBtn} onClick={() => { setEditMode(false); setDraftText(issue.narrative); }}>Cancel</button>
                      <button className={styles.saveBtn} onClick={handleSave} disabled={saving}>
                        {saving ? 'Saving...' : 'Save Draft'}
                      </button>
                    </>
                  )}
                  {issue.featuredTrade && !editMode && (
                    <a
                      className={styles.chartBtn}
                      href={`/?ticker=${issue.featuredTrade.ticker}`}
                      target="_blank"
                      rel="noreferrer"
                      title={`View chart for ${issue.featuredTrade.ticker} — Trade of the Week`}
                    >
                      📈 View Chart ({issue.featuredTrade.ticker})
                    </a>
                  )}
                  {issue.status !== 'published' && !editMode && (
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
                /* Rendered article */
                <article
                  className={styles.articleBody}
                  dangerouslySetInnerHTML={{ __html: renderedHtml }}
                />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
