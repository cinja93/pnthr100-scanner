import { useState, useRef, useEffect } from 'react';
import { useAumShield } from '../contexts/AumShieldContext';
import { API_BASE, authHeaders } from '../services/api';

const DEFAULT_UNLOCK_MS = 10 * 60 * 1000;

const DURATION_OPTIONS = [
  { label: '10 min',  ms: 10 * 60 * 1000 },
  { label: '1 hour',  ms: 60 * 60 * 1000 },
  { label: '4 hours', ms: 4 * 60 * 60 * 1000 },
  { label: '8 hours', ms: 8 * 60 * 60 * 1000 },
];

export default function AumShield({ children, style = {}, block = false, showDuration = false }) {
  const { hasPin, setHasPin } = useAumShield();
  const [locked, setLocked] = useState(true);
  const [showPrompt, setShowPrompt] = useState(false);
  const [pin, setPinVal] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [step, setStep] = useState('enter');
  const [selectedDuration, setSelectedDuration] = useState(DEFAULT_UNLOCK_MS);
  const timerRef = useRef(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const Tag = block ? 'div' : 'span';

  if (hasPin === null) {
    return <Tag style={{ ...style, color: '#333' }}>{block ? null : '••••'}</Tag>;
  }

  if (!locked) return <>{children}</>;

  const startTimer = (ms) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setLocked(true), ms || DEFAULT_UNLOCK_MS);
  };

  const handleSubmit = async () => {
    if (hasPin) {
      const res = await fetch(`${API_BASE}/api/user/aum-pin/verify`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ pin }),
      });
      const d = await res.json();
      if (d.success) {
        setLocked(false);
        startTimer(showDuration ? selectedDuration : DEFAULT_UNLOCK_MS);
        setShowPrompt(false);
        setPinVal('');
        setError('');
      } else {
        setError('Incorrect PIN');
        setPinVal('');
      }
    } else {
      if (step === 'enter') {
        if (!/^\d{4}$/.test(pin)) { setError('Enter 4 digits'); return; }
        setStep('confirm');
        setError('');
        return;
      }
      if (confirm !== pin) { setError('PINs do not match'); setConfirm(''); return; }
      const res = await fetch(`${API_BASE}/api/user/aum-pin`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ pin }),
      });
      const d = await res.json();
      if (d.success) {
        setHasPin(true);
        setLocked(false);
        startTimer(showDuration ? selectedDuration : DEFAULT_UNLOCK_MS);
        setShowPrompt(false);
        setPinVal('');
        setConfirm('');
        setError('');
        setStep('enter');
      } else {
        setError('Failed to save PIN');
      }
    }
  };

  const handleKey = (e) => { if (e.key === 'Enter') handleSubmit(); };

  const close = () => { setShowPrompt(false); setPinVal(''); setConfirm(''); setError(''); setStep('enter'); };

  return (
    <Tag style={{ position: 'relative', display: block ? 'block' : 'inline-block', ...style }}>
      {block ? (
        <div
          onClick={() => setShowPrompt(true)}
          style={{
            cursor: 'pointer', background: '#0a0a0a', borderRadius: 6,
            border: '1px solid #2a2a2a', padding: '16px 24px',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            userSelect: 'none',
          }}
          title="Click to unlock"
        >
          <span style={{ fontSize: 16 }}>🔒</span>
          <span style={{ color: '#555', fontSize: 12, fontWeight: 700, fontFamily: 'monospace', letterSpacing: '0.06em' }}>
            PIN PROTECTED — CLICK TO UNLOCK
          </span>
        </div>
      ) : (
        <span
          onClick={() => setShowPrompt(true)}
          style={{
            cursor: 'pointer', color: '#333', fontWeight: 700,
            background: '#1a1a1a', borderRadius: 4, padding: '0 6px',
            border: '1px solid #2a2a2a', userSelect: 'none',
          }}
          title="Click to unlock AUM"
        >••••••</span>
      )}
      {showPrompt && (
        <>
          <div onClick={close} style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9998,
          }} />
          <div style={{
            position: 'absolute', top: '100%', left: 0, zIndex: 9999,
            background: '#1a1a1a', border: '1px solid #444', borderRadius: 6,
            padding: 12, minWidth: 220, marginTop: 4, boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
          }}>
            <div style={{ fontSize: 11, color: '#888', marginBottom: 8, fontFamily: 'monospace' }}>
              {hasPin
                ? 'Enter 4-digit PIN'
                : step === 'enter' ? 'Create a 4-digit PIN' : 'Confirm your PIN'}
            </div>
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              autoFocus
              value={hasPin ? pin : step === 'enter' ? pin : confirm}
              onChange={e => {
                const v = e.target.value.replace(/\D/g, '').slice(0, 4);
                if (hasPin || step === 'enter') setPinVal(v);
                else setConfirm(v);
              }}
              onKeyDown={handleKey}
              style={{
                width: '100%', padding: '8px 10px', fontSize: 18, fontFamily: 'monospace',
                background: '#0a0a0a', border: '1px solid #333', borderRadius: 4,
                color: '#e8e6e3', textAlign: 'center', letterSpacing: 8,
                outline: 'none',
              }}
              placeholder="····"
            />
            {showDuration && hasPin && (
              <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
                {DURATION_OPTIONS.map(d => (
                  <button
                    key={d.ms}
                    onClick={() => setSelectedDuration(d.ms)}
                    style={{
                      flex: 1, padding: '4px 2px', fontSize: 9, fontWeight: 700,
                      fontFamily: 'monospace', borderRadius: 3, cursor: 'pointer',
                      border: selectedDuration === d.ms ? '1px solid #fcf000' : '1px solid #333',
                      background: selectedDuration === d.ms ? 'rgba(252,240,0,0.15)' : '#0a0a0a',
                      color: selectedDuration === d.ms ? '#fcf000' : '#666',
                    }}
                  >{d.label}</button>
                ))}
              </div>
            )}
            {error && <div style={{ color: '#dc3545', fontSize: 11, marginTop: 4 }}>{error}</div>}
            <button
              onClick={handleSubmit}
              style={{
                width: '100%', marginTop: 8, padding: '6px 0',
                background: '#28a745', border: 'none', borderRadius: 4,
                color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                fontFamily: 'monospace',
              }}
            >{hasPin ? 'UNLOCK' : step === 'enter' ? 'NEXT' : 'SET PIN'}</button>
          </div>
        </>
      )}
    </Tag>
  );
}
