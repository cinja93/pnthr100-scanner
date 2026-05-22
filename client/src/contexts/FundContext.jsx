import { createContext, useContext, useState, useMemo } from 'react';

const FundContext = createContext({ activeFund: 'ai' });

export function FundProvider({ children }) {
  const [activeFund, setActiveFund] = useState(() =>
    localStorage.getItem('activeFund') || 'ai'
  );

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
