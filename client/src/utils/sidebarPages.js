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
 */
const SIDEBAR_PAGES = [
  // This Week
  { key: 'perch',      label: 'PNTHR Perch' },
  { key: 'earnings',   label: 'PNTHR Calendar' },

  // PNTHR Live
  { key: 'pulse',      label: 'PNTHR Pulse' },
  { key: 'assistant',  label: 'PNTHR Assistant',  personalData: true },
  { key: 'orders',     label: 'PNTHR Orders' },
  { key: 'aiOrders',   label: 'PNTHR AI Orders' },

  // PNTHR Hunt
  { key: 'search',     label: 'PNTHR Search' },
  { key: 'prey',       label: 'PNTHR Prey' },
  { key: 'apex',       label: 'PNTHR Kill' },
  { key: 'aiKill',     label: 'PNTHR AI Kill' },

  // PNTHR Jungle
  { key: 'jungle',     label: 'Carnivore Jungle' },
  { key: 'aiJungle',   label: 'PNTHR AI 300 Index' },
  { key: 'aiSectors',  label: 'PNTHR AI Sectors' },
  { key: 'bondHeat',   label: 'PNTHR Bond Heat' },
  { key: 'long',       label: 'PNTHR 100 Longs' },
  { key: 'short',      label: 'PNTHR 100 Shorts' },
  { key: 'etf',        label: "PNTHR ETF's" },
  { key: 'sectors',    label: 'PNTHR Sectors' },

  // PNTHR Data
  { key: 'journal',    label: 'PNTHR Journal',    personalData: true },
  { key: 'portfolio',  label: 'PNTHR Portfolio',  personalData: true },
  { key: 'ir-live',    label: 'AI Intelligence Report Live' },
  { key: 'watchlist',  label: 'Watchlist' },

  // Always last
  { key: 'data-room',  label: 'PNTHR Data Room' },
];

export default SIDEBAR_PAGES;
