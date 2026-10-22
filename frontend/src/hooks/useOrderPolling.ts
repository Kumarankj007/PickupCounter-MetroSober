import { useEffect, useState } from 'react';
import { apiRequest } from '../api';
import type { Order } from '../types';

const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATUSES = new Set(['paid', 'expired', 'needs_review', 'claimed']);

export function useOrderPolling(orderId: string | null) {
  const [order, setOrder] = useState<Order | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  useEffect(() => {
    if (!orderId) {
      setOrder(null);
      setPollError(null);
      return;
    }

    let cancelled = false;
    let timeoutId: number | undefined;
    const poll = async () => {
      try {
        const latest = await apiRequest<Order>(`/orders/${orderId}`);
        if (cancelled) return;
        setOrder(latest);
        setPollError(null);
        if (!TERMINAL_STATUSES.has(latest.status)) {
          timeoutId = window.setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (error) {
        if (cancelled) return;
        setPollError(error instanceof Error ? error.message : 'Could not refresh order status.');
        timeoutId = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    };
    void poll();

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [orderId]);

  return { order, setOrder, pollError };
}
