import { useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../AuthContext';
import { API_BASE, authHeaders } from '../services/api';

function sendEvent(payload) {
  fetch(`${API_BASE}/api/portal/events`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

/**
 * useEventTracker — tracks portal user activity (page views with duration, doc views, sessions).
 * Fires for investor-role and member-role (VIP) users on investor/vip portals.
 */
export function useEventTracker() {
  const { currentUser } = useAuth() || {};
  const isTracked = currentUser?.role === 'investor' || currentUser?.role === 'member';
  const sessionLogged = useRef(false);
  const pageRef = useRef(null);
  const enteredAt = useRef(null);

  useEffect(() => {
    if (!isTracked || sessionLogged.current) return;
    sessionLogged.current = true;
    sendEvent({ type: 'session_start' });
  }, [isTracked]);

  const flushPageDuration = useCallback(() => {
    if (!isTracked || !pageRef.current || !enteredAt.current) return;
    const duration = Math.round((Date.now() - enteredAt.current) / 1000);
    if (duration > 0 && duration < 7200) {
      sendEvent({ type: 'page_exit', page: pageRef.current, extra: { duration } });
    }
    pageRef.current = null;
    enteredAt.current = null;
  }, [isTracked]);

  const trackPageView = useCallback((page) => {
    if (!isTracked) return;
    flushPageDuration();
    pageRef.current = page;
    enteredAt.current = Date.now();
    sendEvent({ type: 'page_view', page });
  }, [isTracked, flushPageDuration]);

  const trackDocView = useCallback((documentId, documentName) => {
    if (!isTracked) return;
    sendEvent({ type: 'document_view', documentId, documentName });
  }, [isTracked]);

  // Flush duration on tab close / navigation away
  useEffect(() => {
    if (!isTracked) return;
    const handleUnload = () => {
      if (!pageRef.current || !enteredAt.current) return;
      const duration = Math.round((Date.now() - enteredAt.current) / 1000);
      if (duration > 0 && duration < 7200) {
        const headers = authHeaders();
        const token = headers.Authorization?.replace('Bearer ', '') || '';
        const payload = JSON.stringify({ type: 'page_exit', page: pageRef.current, extra: { duration }, _token: token });
        const blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon?.(`${API_BASE}/api/portal/events-beacon`, blob);
      }
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, [isTracked]);

  return { trackPageView, trackDocView, isTracked };
}
