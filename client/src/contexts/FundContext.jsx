import { createContext, useContext, useState, useMemo, useEffect } from 'react';

const FundContext = createContext({ activeFund: 'ai' });

export function FundProvider({ children }) {
  const [activeFund, setActiveFund] = useState(() =>
    localStorage.getItem('activeFund') || 'ai'
  );

  useEffect(() => {
    const sync = () => setActiveFund(localStorage.getItem('activeFund') || 'ai');
    window.addEventListener('pnthr-fund-change', sync);
    return () => window.removeEventListener('pnthr-fund-change', sync);
  }, []);

  const value = useMemo(() => ({
    activeFund,
    isAI: activeFund === 'ai',
    isCarn: activeFund === 'carn',
    setActiveFund(fund) {
      setActiveFund(fund);
      localStorage.setItem('activeFund', fund);
    },
    toggleFund() {
      setActiveFund(prev => {
        const next = prev === 'ai' ? 'carn' : 'ai';
        localStorage.setItem('activeFund', next);
        return next;
      });
    },
  }), [activeFund]);

  return <FundContext.Provider value={value}>{children}</FundContext.Provider>;
}

export function useFund() {
  return useContext(FundContext);
}
