import styles from './Sidebar.module.css';
import pnthrLogo from '../assets/PNTHR FUNDS Logo black background 2 lines.png';
import builtWithLove from '../assets/Built with Love.jpg';

const NAV_ITEMS = [
  { key: 'long',      label: 'Scan Long',  icon: '📈', section: 'SCANNER' },
  { key: 'short',     label: 'Scan Short', icon: '📉' },
  { key: 'sectors',   label: 'Sectors',    icon: '📊', dividerBefore: true },
  { key: 'watchlist', label: 'Watchlist',  icon: '👁' },
  { key: 'portfolio', label: 'Portfolio',  icon: '📁', soon: true },
];

export default function Sidebar({ activePage, onNavigate }) {
  return (
    <aside className={styles.sidebar}>
      {/* Logo */}
      <div className={styles.logoArea}>
        <img src={pnthrLogo} alt="PNTHR Funds" className={styles.logo} />
      </div>

      {/* Navigation */}
      <nav className={styles.nav}>
        {NAV_ITEMS.map((item) => (
          <div key={item.key}>
            {item.section && (
              <div className={styles.sectionLabel}>{item.section}</div>
            )}
            {item.dividerBefore && <div className={styles.divider} />}
            <button
              className={`${styles.navItem} ${activePage === item.key ? styles.navItemActive : ''} ${item.soon ? styles.navItemDisabled : ''}`}
              onClick={() => !item.soon && onNavigate(item.key)}
              disabled={item.soon}
              title={item.soon ? 'Coming soon' : item.label}
            >
              <span className={styles.navIcon}>{item.icon}</span>
              <span className={styles.navLabel}>{item.label}</span>
              {item.soon && <span className={styles.soonBadge}>Soon</span>}
            </button>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className={styles.sidebarFooter}>
        <div className={styles.loveFrame}>
          <img src={builtWithLove} alt="Built with Love" className={styles.loveImg} />
        </div>
        <p className={styles.loveText}>Built with love by Cindy and Blazer</p>
      </div>
    </aside>
  );
}
