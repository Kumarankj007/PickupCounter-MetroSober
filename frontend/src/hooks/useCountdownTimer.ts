import { useEffect, useState } from 'react';

/**
 * Countdown anchored to performance.now(), not Date.now() or the kiosk wall clock.
 * Recompute from a monotonic deadline instead of subtracting one second per interval,
 * so late intervals/background-tab pauses do not accumulate drift.
 */
export function useCountdownTimer(initialSeconds: number | null, active: boolean): number {
  const [remainingSeconds, setRemainingSeconds] = useState(Math.max(0, Math.ceil(initialSeconds ?? 0)));

  useEffect(() => {
    if (initialSeconds === null) {
      setRemainingSeconds(0);
      return;
    }
    const deadline = performance.now() + Math.max(0, initialSeconds) * 1000;
    const tick = () => {
      const next = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
      setRemainingSeconds(next);
    };
    tick();
    if (!active) return;
    const interval = window.setInterval(tick, 100);
    return () => window.clearInterval(interval);
  }, [initialSeconds, active]);

  return remainingSeconds;
}

export function formatCountdown(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const secs = Math.max(0, totalSeconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}
