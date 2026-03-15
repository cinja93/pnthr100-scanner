// KillBadge.jsx — Police badge shape for PNTHR Kill top-10 ranks
// Black shield badge with PNTHR KILL text and rank number 1-10

export default function KillBadge({ rank, size = 56 }) {
  const height = Math.round(size * 1.1);
  const uid = `kb-${rank}`;

  return (
    <svg
      viewBox="0 0 80 88"
      width={size}
      height={height}
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'block', flexShrink: 0 }}
      aria-label={`PNTHR Kill rank ${rank}`}
    >
      <defs>
        {/* Subtle gold glow */}
        <filter id={`${uid}-glow`} x="-25%" y="-25%" width="150%" height="150%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur" />
          <feColorMatrix in="blur" type="matrix"
            values="1 0.9 0 0 0  0.9 0.8 0 0 0  0 0 0 0 0  0 0 0 0.7 0" result="glow" />
          <feMerge>
            <feMergeNode in="glow" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        {/* Drop shadow */}
        <filter id={`${uid}-shadow`} x="-20%" y="-10%" width="140%" height="130%">
          <feDropShadow dx="0" dy="3" stdDeviation="3" floodColor="#000" floodOpacity="0.55" />
        </filter>
      </defs>

      {/* ── Outer badge shape: classic police shield ────────────────────────── */}
      {/* Wide at top, sides angle in, pointed bottom */}
      <path
        d="M40 4 L73 15 L76 46 C74 67 60 80 40 87 C20 80 6 67 4 46 L7 15 Z"
        fill="#111111"
        stroke="#fcf000"
        strokeWidth="2.8"
        filter={`url(#${uid}-shadow)`}
      />

      {/* Inner decorative border */}
      <path
        d="M40 10 L68 20 L71 46 C69 64 57 75 40 82 C23 75 11 64 9 46 L12 20 Z"
        fill="none"
        stroke="#fcf000"
        strokeWidth="1"
        strokeOpacity="0.3"
      />

      {/* Top horizontal accent bar */}
      <line x1="21" y1="21" x2="59" y2="21" stroke="#fcf000" strokeWidth="1.2" strokeOpacity="0.55" />

      {/* ── PNTHR text ──────────────────────────────────────────────────────── */}
      <text
        x="40" y="34"
        textAnchor="middle"
        fill="#fcf000"
        fontSize="10.5"
        fontWeight="900"
        letterSpacing="2"
        fontFamily="'Arial Black', 'Arial', sans-serif"
        filter={`url(#${uid}-glow)`}
      >
        PNTHR
      </text>

      {/* ── KILL text ───────────────────────────────────────────────────────── */}
      <text
        x="40" y="46"
        textAnchor="middle"
        fill="#fcf000"
        fontSize="9.5"
        fontWeight="800"
        letterSpacing="3.5"
        fontFamily="'Arial Black', 'Arial', sans-serif"
        filter={`url(#${uid}-glow)`}
      >
        KILL
      </text>

      {/* Mid divider dots */}
      <circle cx="25" cy="56" r="1.5" fill="#fcf000" opacity="0.45" />
      <line   x1="29" y1="56" x2="51" y2="56" stroke="#fcf000" strokeWidth="0.7" strokeOpacity="0.3" />
      <circle cx="55" cy="56" r="1.5" fill="#fcf000" opacity="0.45" />

      {/* ── Rank number ─────────────────────────────────────────────────────── */}
      <text
        x="40" y="76"
        textAnchor="middle"
        fill="#ffffff"
        fontSize={rank >= 10 ? "22" : "26"}
        fontWeight="900"
        fontFamily="'Arial Black', 'Arial', sans-serif"
      >
        {rank}
      </text>
    </svg>
  );
}
