/**
 * Single source of truth for every page that can appear in the sidebar.
 * PortalContext imports this to auto-populate the assignable-pages list
 * for the Investor Portal — so adding a new sidebar button automatically
 * makes it available as a portal checkbox (unchecked by default).
 *
 * personalData: true  → page shows user-specific account data (NAV, positions).
 *                        Defaults to UNCHECKED for new investors.
 * adminOnly: true     → page is only shown to admins in the sidebar.
 *                        Still assignable in the portal for VIPs/investors.
 *
 * Groups and labels must match Sidebar.jsx NAV_GROUPS exactly.
 */
const SIDEBAR_PAGES = [
  // Investor's Den
  { key: 'ir-live',           label: 'Intelligence Report' },
  { key: 'data-room',        label: 'Data Room' },

  // This Week
  { key: 'perch',            label: 'Perch' },
  { key: 'earnings',         label: 'Calendar' },

  // Market Pulse
  { key: 'pulse',            label: 'Pulse' },
  { key: 'newHighsLows',     label: 'New Highs' },
  { key: 'ai300Index',       label: 'AI 300 Index' },
  { key: 'bondHeat',         label: 'Bond Yields' },

  // PNTHR Live
  { key: 'orders',           label: 'Orders',          personalData: true },
  { key: 'pnthrTree',        label: 'PNTHR Tree',      personalData: true },

  // Strategy
  { key: 'prey',             label: 'Prey' },
  { key: 'apex',             label: 'Kill' },
  { key: 'search',           label: 'Search' },

  // Universe
  { key: 'jungle',           label: 'Jungle' },
  { key: 'sectors',          label: 'Sectors' },
  { key: 'jungleHeat',       label: 'Heat Map' },
  { key: 'etf',              label: "ETF's" },
  { key: 'long',             label: '100 Longs' },
  { key: 'short',            label: '100 Shorts' },

  // Internal
  { key: 'assistant',        label: 'Assistant',       personalData: true },
  { key: 'journal',          label: 'Journal',         personalData: true },
  { key: 'signal-history',   label: 'Signal History',  personalData: true },
  { key: 'history',          label: 'Kill 10',         personalData: true },
  { key: 'kill-test',        label: 'Kill Test',       personalData: true },
  { key: 'compliance',       label: 'Compliance',      personalData: true },
  { key: 'watchlist',        label: 'Watchlist' },
  { key: 'portfolio',        label: 'Portfolio',       personalData: true },
];

export default SIDEBAR_PAGES;
