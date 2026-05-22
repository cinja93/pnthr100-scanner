import { useState } from 'react';
import { useAumShield } from '../contexts/AumShieldContext';

export default function AumShield({ children, style = {} }) {
  const { locked, hasPin, unlock, setPin } = useAumShield();
  const [showPrompt, setShowPrompt] = useState(false);
  const [pin, setPinVal] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [step, setStep] = useState('enter');

  if (hasPin === null) {
    return <span style={{ ...style, color: '#333' }}>••••</span>;
  }

  if (!locked) return <>{children}</>;

  const handleSubmit = async () => {
    if (hasPin) {
      const ok = await unlock(pin);
      if (!ok) { setError('Incorrect PIN'); setPinVal(''); }
      else { setShowPrompt(false); setPinVal(''); setError(''); }
    } else {
      if (step === 'enter') {
        if (!/^\d{4}$/.test(pin)) { setError('Enter 4 digits'); return; }
        setStep('confirm');
        setError('');
        return;
      }
      if (confirm !== pin) { setError('PINs do not match'); setConfirm(''); return; }
      const ok = await setPin(pin);
      if (ok) { setShowPrompt(false); setPinVal(''); setConfirm(''); setError(''); setStep('enter'); }
      else { setError('Failed to save PIN'); }
    }
  };

  const handleKey = (e) => { if (e.key === 'Enter') handleSubmit(); };

  const close = () => { setShowPrompt(false); setPinVal(''); setConfirm(''); setError(''); setStep('enter'); };

  return (
    <span style={{ position: 'relative', display: 'inline-block', ...style }}>
      <span
        onClick={() => setShowPrompt(true)}
        style={{
          cursor: 'pointer', color: '#333', fontWeight: 700,
          background: '#1a1a1a', borderRadius: 4, padding: '0 6px',
          border: '1px solid #2a2a2a', userSelect: 'none',
        }}
        title="Click to unlock AUM"
      >••••••</span>
      {showPrompt && (
        <>
          <div onClick={close} style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9998,
          }} />
          <div style={{
            position: 'absolute', top: '100%', left: 0, zIndex: 9999,
            background: '#1a1a1a', border: '1px solid #444', borderRadius: 6,
            padding: 12, minWidth: 200, marginTop: 4, boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
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
    </span>
  );
}
