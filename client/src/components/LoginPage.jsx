import { useState } from 'react';
import styles from './LoginPage.module.css';
import logo from '../assets/panther head.png';

export default function LoginPage({ onLogin }) {
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [submitted, setSubmitted] = useState(false); // pending confirmation shown

  const API_BASE = import.meta.env.DEV ? '' : (import.meta.env.VITE_API_URL || '');

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    if (mode === 'register') {
      if (password !== confirmPassword) { setError('Passwords do not match'); return; }
    }

    setLoading(true);
    try {
      if (mode === 'register') {
        const response = await fetch(`${API_BASE}/auth/request-access`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, password }),
        });
        const data = await response.json();
        if (!response.ok) { setError(data.error || 'Something went wrong'); return; }
        setSubmitted(true);
        return;
      }

      // Login
      const response = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (data.pending) {
          setError('Your account is pending approval. You will receive an email when approved.');
        } else {
          setError(data.error || 'Something went wrong');
        }
        return;
      }
      onLogin(data.token, data.email, data.profile ?? null, data.role ?? 'member');
    } catch {
      setError('Unable to connect to server. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  function switchMode() {
    setMode(m => m === 'login' ? 'register' : 'login');
    setError(null);
    setSubmitted(false);
    setPassword('');
    setConfirmPassword('');
    setName('');
  }

  // Pending confirmation screen
  if (submitted) {
    return (
      <div className={styles.backdrop}>
        <div className={styles.card}>
          <img src={logo} alt="PNTHR Funds" className={styles.logo} />
          <h1 className={styles.title}>Request Submitted</h1>
          <p style={{ color: '#aaa', fontSize: 14, textAlign: 'center', lineHeight: 1.6, margin: '16px 0' }}>
            Your account request has been submitted.<br />
            You will receive an email at <strong style={{ color: '#fff' }}>{email}</strong> when approved.
          </p>
          <button className={styles.switchLink} onClick={switchMode} type="button" style={{ marginTop: 12 }}>
            Back to Sign In
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.backdrop}>
      <div className={styles.card}>
        <img src={logo} alt="PNTHR Funds" className={styles.logo} />
        <h1 className={styles.title}>{mode === 'login' ? 'Sign In' : 'Request Access'}</h1>

        <form onSubmit={handleSubmit} className={styles.form}>
          {mode === 'register' && (
            <label className={styles.label}>
              Full Name
              <input
                type="text"
                className={styles.input}
                value={name}
                onChange={e => setName(e.target.value)}
                required
                autoFocus
                placeholder="Your full name"
              />
            </label>
          )}

          <label className={styles.label}>
            Email
            <input
              type="email"
              className={styles.input}
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoFocus={mode === 'login'}
              autoComplete="email"
              placeholder="you@example.com"
            />
          </label>

          <label className={styles.label}>
            Password
            <input
              type="password"
              className={styles.input}
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              placeholder="Min. 8 characters"
              minLength={8}
            />
          </label>

          {mode === 'register' && (
            <label className={styles.label}>
              Confirm Password
              <input
                type="password"
                className={styles.input}
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                required
                autoComplete="new-password"
                placeholder="Repeat password"
              />
            </label>
          )}

          {error && <p className={styles.error}>{error}</p>}

          <button type="submit" className={styles.submitBtn} disabled={loading}>
            {loading ? 'Please wait…' : mode === 'login' ? 'Sign In' : 'Submit Request'}
          </button>
        </form>

        <p className={styles.switchText}>
          {mode === 'login' ? "Don't have an account?" : 'Already have an account?'}{' '}
          <button className={styles.switchLink} onClick={switchMode} type="button">
            {mode === 'login' ? 'Request access' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}
