import { useEffect, useMemo, useState } from 'react';
import { UserAvatar } from '@/components/UserAvatar';

interface DisplayUser {
  userId: string;
  username: string;
  imageUrl?: string | null;
  iconColor?: string | null;
}

interface PointSource {
  id: string;
  label: string;
  pointsByUser: Record<string, number>;
}

interface FinalResultsViewProps {
  users: DisplayUser[];
  pointSources: PointSource[];
}

const LABEL_MS = 900;
const FALL_MS = 1000;
const PAUSE_MS = 900;

function wait(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

export default function FinalResultsView({ users, pointSources }: FinalResultsViewProps) {
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, []);

  const [sourceIdx, setSourceIdx] = useState(-1);
  const [phase, setPhase] = useState<'idle' | 'label' | 'falling' | 'landed'>('idle');
  const [totals, setTotals] = useState<Record<string, number>>({});

  useEffect(() => {
    if (pointSources.length === 0) return;
    let cancelled = false;

    async function run() {
      setTotals({});
      for (let i = 0; i < pointSources.length; i++) {
        if (cancelled) return;
        setSourceIdx(i);
        setPhase('label');
        await wait(LABEL_MS);
        if (cancelled) return;
        setPhase('falling');
        await wait(FALL_MS);
        if (cancelled) return;
        setTotals(prev => {
          const next = { ...prev };
          for (const [uid, pts] of Object.entries(pointSources[i].pointsByUser)) {
            next[uid] = (next[uid] ?? 0) + pts;
          }
          return next;
        });
        setPhase('landed');
        await wait(PAUSE_MS);
      }
      if (!cancelled) setPhase('idle');
    }

    run();
    return () => { cancelled = true; };
  }, [pointSources]);

  const maxTotal = useMemo(() => {
    let max = 0;
    for (const user of users) {
      let sum = 0;
      for (const source of pointSources) sum += source.pointsByUser[user.userId] ?? 0;
      if (sum > max) max = sum;
    }
    return Math.max(max, 1);
  }, [users, pointSources]);

  const currentSource = sourceIdx >= 0 ? pointSources[sourceIdx] : null;
  const showHeader = currentSource !== null && (phase === 'label' || phase === 'falling' || phase === 'landed');
  const showFalling = currentSource !== null && phase === 'falling';

  return (
    <div className="fixed inset-0 z-[200] bg-black overflow-hidden">
      <div className="pointer-events-none absolute inset-0 animate-edge-pulse" />

      <div
        className={`absolute inset-x-0 top-6 z-10 px-4 text-center text-lg font-semibold tracking-wide text-white transition-opacity duration-500 sm:top-8 sm:text-2xl ${
          showHeader ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {currentSource?.label}
      </div>

      <div className="relative flex h-full w-full items-end justify-center gap-1 px-4 pb-8 pt-16 sm:gap-2 sm:px-8">
        {users.map(user => {
          const total = totals[user.userId] ?? 0;
          const pct = Math.min((total / maxTotal) * 100, 100);
          const sourcePoints = currentSource?.pointsByUser[user.userId] ?? 0;

          return (
            <div key={user.userId} className="relative flex h-full min-w-0 flex-1 flex-col items-center justify-end">
              {showFalling && (
                <span
                  key={`${currentSource?.id}-fall`}
                  className={`animate-points-fall absolute left-1/2 z-20 -translate-x-1/2 whitespace-nowrap text-sm font-bold sm:text-base ${
                    sourcePoints > 0 ? 'text-green-400' : 'text-gray-500'
                  }`}
                >
                  {sourcePoints > 0 ? `+${sourcePoints}` : '0'}
                </span>
              )}

              <div className="flex w-full flex-1 items-end">
                <div
                  className="w-full rounded-t-sm bg-gradient-to-t from-primary to-primary/60 transition-[height] duration-700 ease-out"
                  style={{ height: `${pct}%` }}
                />
              </div>
              <div className="mt-2 flex max-w-full flex-col items-center gap-1">
                <UserAvatar
                  username={user.username}
                  imageUrl={user.imageUrl}
                  iconColor={user.iconColor}
                  className="h-8 w-8 sm:h-10 sm:w-10"
                />
                <span className="max-w-full truncate text-[10px] font-medium text-white sm:text-xs">
                  {user.username}
                </span>
                <span className="text-xs font-bold text-white sm:text-sm">{total}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
