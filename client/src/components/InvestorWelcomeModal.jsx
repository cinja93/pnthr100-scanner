import logo from '../assets/panther head.png';

export default function InvestorWelcomeModal({ loginCount, maxLogins, onClose }) {
  const remaining = Math.max(0, (maxLogins || 5) - (loginCount || 0));

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 2000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: '#111', border: '1px solid #222', borderRadius: 14,
        padding: '44px 40px 36px', width: '100%', maxWidth: 480, textAlign: 'center',
      }}>
        <img src={logo} alt="PNTHR Funds" style={{ width: 70, height: 70, objectFit: 'contain', marginBottom: 20 }} />

        <h2 style={{ fontSize: 22, fontWeight: 800, color: '#fff', margin: '0 0 6px', letterSpacing: '0.03em' }}>
          Welcome to <span style={{ color: '#FCF000' }}>PNTHR Funds</span>
        </h2>

        <p style={{
          fontSize: 13, color: '#aaa', lineHeight: 1.7, margin: '16px 0 0',
          textAlign: 'left',
        }}>
          You've been granted exclusive access to a preview of the <strong style={{ color: '#fff' }}>PNTHR's Den</strong>.
          This is a version of the proprietary platform powering PNTHR Fund's, Carnivore Quant Fund LP's
          investment process. What you're seeing is a curated selection of the tools and analytics our team
          uses daily to identify, score, and size opportunities across the market. The full internal platform
          includes a significant number of additional dimensions of analysis, risk management systems, and
          execution infrastructure not available in this preview.
        </p>

        {/* Session counter */}
        <div style={{
          margin: '22px 0', padding: '14px 18px',
          background: '#0a0a0a', border: '1px solid #222', borderRadius: 8,
          textAlign: 'center',
        }}>
          <div style={{ fontSize: 11, color: '#666', letterSpacing: '0.06em', marginBottom: 6, fontWeight: 600 }}>
            SESSION ACCESS
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            {Array.from({ length: maxLogins || 5 }).map((_, i) => (
              <div key={i} style={{
                width: 28, height: 6, borderRadius: 3,
                background: i < (loginCount || 0) ? '#FCF000' : '#222',
                transition: 'background 0.3s',
              }} />
            ))}
          </div>
          <div style={{ fontSize: 12, color: '#888', marginTop: 8 }}>
            <span style={{ color: '#FCF000', fontWeight: 700 }}>{remaining}</span> of {maxLogins || 5} sessions remaining
          </div>
        </div>

        <p style={{
          fontSize: 12, color: '#777', lineHeight: 1.6, margin: '0 0 24px',
          textAlign: 'left',
        }}>
          Each login counts as one session — take your time, click through the charts, and see
          how PNTHR thinks about the market.
        </p>

        <button
          onClick={onClose}
          style={{
            width: '100%', padding: '13px', background: '#FCF000', color: '#000',
            fontSize: 14, fontWeight: 700, border: 'none', borderRadius: 8,
            cursor: 'pointer', letterSpacing: '0.04em', marginBottom: 16,
          }}
        >
          Explore the Platform
        </button>

        <p style={{ fontSize: 11, color: '#555', margin: 0, lineHeight: 1.6 }}>
          Questions or ready to take the next step?<br />
          <a href="mailto:Cindy@pnthrfunds.com" style={{ color: '#FCF000', textDecoration: 'none' }}>
            Cindy@pnthrfunds.com
          </a>
        </p>
      </div>
    </div>
  );
}
