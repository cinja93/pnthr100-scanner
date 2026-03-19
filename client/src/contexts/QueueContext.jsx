import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { fetchNav } from '../services/api';
import { useAuth } from '../AuthContext';

const QueueContext = createContext(null);

const SESSION_KEY = 'pnthr_queue';

export function QueueProvider({ children }) {
  const { isAdmin } = useAuth();

  const [queue, setQueue] = useState(() => {
    try {
      const saved = sessionStorage.getItem(SESSION_KEY);
      return saved ? new Map(JSON.parse(saved)) : new Map();
    } catch { return new Map(); }
  });

  const [nav, setNav]                     = useState(null);
  const [showQueuePanel, setShowQueuePanel] = useState(false);
  const [sendSuccess, setSendSuccess]       = useState(false);
  const [sendingQueue, setSendingQueue]     = useState(false);

  // Load NAV on mount (admin only — members don't use sizing)
  useEffect(() => {
    if (!isAdmin) return;
    fetchNav().then(d => setNav(d?.nav || 100000)).catch(() => setNav(100000));
  }, [isAdmin]);

  // Persist queue to sessionStorage on every change
  useEffect(() => {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify([...queue])); } catch {}
  }, [queue]);

  const toggleQueue = useCallback((item) => {
    setQueue(prev => {
      const next = new Map(prev);
      if (item._remove) {
        next.delete(item.ticker);
      } else {
        next.set(item.ticker, item);
      }
      return next;
    });
  }, []);

  const clearQueue = useCallback(() => {
    setQueue(new Map());
    try { sessionStorage.removeItem(SESSION_KEY); } catch {}
  }, []);

  const queuedTickers = useMemo(() => new Set(queue.keys()), [queue]);

  return (
    <QueueContext.Provider value={{
      queue, toggleQueue, clearQueue,
      queuedTickers,
      queueSize: queue.size,
      nav, setNav,
      showQueuePanel, setShowQueuePanel,
      sendSuccess, setSendSuccess,
      sendingQueue, setSendingQueue,
    }}>
      {children}
    </QueueContext.Provider>
  );
}

export function useQueue() {
  return useContext(QueueContext);
}
