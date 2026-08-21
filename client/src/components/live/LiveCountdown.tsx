import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { minutesUntilLock } from '@tournament-predictor/shared';
import { useT } from '@/lib/useT';

// ── Prediction countdown ──────────────────────────────────────────────────────
//
// "Locks in 2h 14m", flipping to "Locked" at kickoff − 60 min.
//
// The rule itself is never re-implemented here: minutesUntilLock comes from
// shared/src/live/lock.ts, the same module the server enforces with. This component only
// decides how often to re-read it.

interface Props {
  kickoffAt: string | null;
  status: string;
  className?: string;
}

/** Re-render often enough to look live, without a per-second timer on 380 fixtures. */
function tickIntervalMs(minutesLeft: number | null): number {
  if (minutesLeft === null) return 60_000;
  if (minutesLeft <= 2) return 5_000;
  if (minutesLeft <= 60) return 15_000;
  return 60_000;
}

export default function LiveCountdown({ kickoffAt, status, className = '' }: Props) {
  const { t } = useT();
  const [minutes, setMinutes] = useState<number | null>(() =>
    minutesUntilLock({ kickoffAt, status: status as never }),
  );

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    function schedule() {
      const next = minutesUntilLock({ kickoffAt, status: status as never });
      if (cancelled) return;
      setMinutes(next);
      timer = setTimeout(schedule, tickIntervalMs(next));
    }

    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [kickoffAt, status]);

  // No kickoff time published yet — common for knockout ties before a draw. The fixture
  // stays open, so saying "locks in …" would be wrong.
  if (minutes === null) {
    return (
      <span className={`text-xs text-muted-foreground ${className}`}>{t('live.kickoffTbd')}</span>
    );
  }

  if (minutes <= 0) {
    return (
      <span className={`inline-flex items-center gap-1 text-xs text-muted-foreground ${className}`}>
        <Lock size={11} />
        {t('live.locked')}
      </span>
    );
  }

  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const mins = minutes % 60;

  const remaining =
    days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  // Under an hour to go is worth drawing attention to.
  const urgent = minutes <= 60;

  return (
    <span
      className={`text-xs ${urgent ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-muted-foreground'} ${className}`}
    >
      {t('live.locksIn', { time: remaining })}
    </span>
  );
}
