import styles from './DataRoomPage.module.css';

const DOCUMENTS = [
  {
    category: 'Fund Formation',
    items: [
      {
        title: 'Private Placement Memorandum',
        subtitle: 'Carnivore Quant Fund, LP — PPM v2.0',
        date: 'April 2026',
        file: '/PNTHR_PPM_v2.pdf',
        icon: '📋',
        badge: 'Updated',
      },
      {
        title: 'System Architecture',
        subtitle: 'PNTHR Signal System — Technical Overview v7',
        date: 'March 2026',
        file: '/PNTHR_System_Architecture_v7.pdf',
        icon: '⚙️',
        badge: null,
      },
    ],
  },
  {
    category: 'Coming Soon',
    items: [
      { title: 'Limited Partnership Agreement',   subtitle: 'Delaware LP — Governing Document',     date: '—', file: null, icon: '📜', badge: 'Pending' },
      { title: 'Subscription Agreement',           subtitle: 'Investor Subscription Form & Reps',    date: '—', file: null, icon: '✍️',  badge: 'Pending' },
      { title: 'Investment Management Agreement',  subtitle: 'GP ↔ STT Capital Advisors, LLC',       date: '—', file: null, icon: '🤝', badge: 'Pending' },
      { title: 'Operating Agreement — GP',         subtitle: 'PNTHR Funds, LLC',                     date: '—', file: null, icon: '🏢', badge: 'Pending' },
      { title: 'Operating Agreement — IM',         subtitle: 'STT Capital Advisors, LLC',             date: '—', file: null, icon: '🏢', badge: 'Pending' },
      { title: 'Form D Filing',                    subtitle: 'SEC Regulation D — Rule 506(b)',        date: '—', file: null, icon: '📑', badge: 'Pending' },
      { title: 'Backtest Report',                  subtitle: 'Full Audit-Grade Backtest 2019–2026',   date: '—', file: null, icon: '📊', badge: 'Pending' },
      { title: 'Annual Audited Financials',        subtitle: 'Independent CPA Audit',                 date: '—', file: null, icon: '🔍', badge: 'Pending' },
    ],
  },
];

export default function DataRoomPage() {
  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.title}>
            <span className={styles.titleYellow}>PNTHR</span> Data Room
          </h1>
          <p className={styles.subtitle}>
            Fund documents, legal filings, and investor materials for Carnivore Quant Fund, LP
          </p>
        </div>
        <div className={styles.confidentialBadge}>CONFIDENTIAL</div>
      </div>

      <div className={styles.notice}>
        <span>🔒</span>
        <span>
          These materials are strictly confidential and intended solely for authorized recipients.
          Distribution or reproduction without express written consent of PNTHR Funds, LLC is prohibited.
        </span>
      </div>

      {/* Document groups */}
      {DOCUMENTS.map((group) => (
        <div key={group.category} className={styles.group}>
          <div className={styles.groupLabel}>{group.category}</div>
          <div className={styles.grid}>
            {group.items.map((doc) => (
              <div
                key={doc.title}
                className={`${styles.card} ${!doc.file ? styles.cardDisabled : ''}`}
                onClick={() => doc.file && window.open(doc.file, '_blank')}
                title={doc.file ? `Open ${doc.title}` : 'Coming soon'}
              >
                <div className={styles.cardTop}>
                  <span className={styles.cardIcon}>{doc.icon}</span>
                  {doc.badge && (
                    <span className={`${styles.badge} ${doc.badge === 'Updated' ? styles.badgeGreen : styles.badgePending}`}>
                      {doc.badge}
                    </span>
                  )}
                </div>
                <div className={styles.cardTitle}>{doc.title}</div>
                <div className={styles.cardSubtitle}>{doc.subtitle}</div>
                <div className={styles.cardFooter}>
                  <span className={styles.cardDate}>{doc.date}</span>
                  {doc.file
                    ? <span className={styles.cardOpen}>Open PDF ↗</span>
                    : <span className={styles.cardSoon}>Coming soon</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Footer note */}
      <div className={styles.footerNote}>
        <b>PNTHR Funds, LLC</b> · General Partner · 15150 W Park Place, Suite 215, Surprise, AZ 85374
        · 602-810-1940 · info@pnthrfunds.com
        <br />
        Carnivore Quant Fund, LP is offered exclusively to Accredited Investors pursuant to
        Regulation D, Rule 506(b). This page and all documents herein are for informational
        purposes only and do not constitute an offer to sell or a solicitation to buy securities.
      </div>
    </div>
  );
}
