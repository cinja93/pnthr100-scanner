import { useState } from 'react';
import logo from '../assets/panther head.png';

const API_BASE = import.meta.env.DEV ? '' : (import.meta.env.VITE_API_URL || '');

export default function InvestorLoginPage({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/auth/investor/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || 'Invalid credentials');
        return;
      }
      onLogin(data.token, data.email, data.profile ?? null, 'investor');
    } catch {
      setError('Unable to connect to server. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0a0a0a',
    }}>
      <div style={{
        background: '#141414',
        border: '1px solid #222',
        borderRadius: 12,
        padding: '48px 40px 40px',
        width: '100%',
        maxWidth: 400,
      }}>
        {/* Logo + branding */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <img src={logo} alt="PNTHR Funds" style={{ width: 80, height: 80, objectFit: 'contain', marginBottom: 16 }} />
          <h1 style={{ fontSize: 24, fontWeight: 800, color: '#fff', margin: '0 0 4px', letterSpacing: '0.04em' }}>
            <span style={{ color: '#FCF000' }}>PNTHR</span> Investor Portal
          </h1>
          <p style={{ fontSize: 13, color: '#666', margin: 0 }}>
            Secure access to fund documents and performance
          </p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, fontWeight: 600, color: '#888', letterSpacing: '0.05em' }}>
            EMAIL
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoFocus
              autoComplete="email"
              placeholder="investor@company.com"
              style={{
                padding: '11px 14px',
                background: '#0a0a0a',
                border: '1px solid #333',
                borderRadius: 6,
                fontSize: 14,
                color: '#fff',
                outline: 'none',
              }}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, fontWeight: 600, color: '#888', letterSpacing: '0.05em' }}>
            PASSWORD
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              placeholder="Enter your password"
              minLength={8}
              style={{
                padding: '11px 14px',
                background: '#0a0a0a',
                border: '1px solid #333',
                borderRadius: 6,
                fontSize: 14,
                color: '#fff',
                outline: 'none',
              }}
            />
          </label>

          {error && (
            <p style={{
              fontSize: 13, color: '#dc3545', margin: 0,
              padding: '8px 12px', background: 'rgba(220,53,69,0.1)',
              borderRadius: 6, border: '1px solid rgba(220,53,69,0.2)',
            }}>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              marginTop: 4,
              padding: '12px',
              background: '#FCF000',
              color: '#000',
              fontSize: 14,
              fontWeight: 700,
              border: 'none',
              borderRadius: 6,
              cursor: loading ? 'default' : 'pointer',
              opacity: loading ? 0.6 : 1,
              letterSpacing: '0.04em',
            }}
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div style={{ marginTop: 32, textAlign: 'center', borderTop: '1px solid #222', paddingTop: 20 }}>
          <p style={{ fontSize: 11, color: '#555', margin: 0, lineHeight: 1.6 }}>
            Need access? Contact your fund administrator.<br />
            <span style={{ color: '#444' }}>PNTHR Funds, LLC - Carnivore Quant LP</span>
          </p>
        </div>
      </div>
    </div>
  );
}
