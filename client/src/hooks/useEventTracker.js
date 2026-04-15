import { useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../AuthContext';
import { API_BASE, authHeaders } from '../services/api';

/**
 * useEventTracker — tracks investor activity (page views, doc views, session events).
 * Only fires for investor-role users. Admin/member users are no-ops.
 */
export function useEventTracker() {
  const { currentUser } = useAuth() || {};
  const isInvestor = currentUser?.role === 'investor';
  const sessionLogged = useRef(false);

  // Log session_start once per mount
  useEffect(() => {
    if (!isInvestor || sessionLogged.current) return;
    sessionLogged.current = true;
    fetch(`${API_BASE}/api/investor/events`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'session_start' }),
    }).catch(() => {});
  }, [isInvestor]);

  const trackPageView = useCallback((page) => {
    if (!isInvestor) return;
    fetch(`${API_BASE}/api/investor/events`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'page_view', page }),
    }).catch(() => {});
  }, [isInvestor]);

  const trackDocView = useCallback((documentId, documentName) => {
    if (!isInvestor) return;
    fetch(`${API_BASE}/api/investor/events`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'document_view', documentId, documentName }),
    }).catch(() => {});
  }, [isInvestor]);

  return { trackPageView, trackDocView, isInvestor };
}
