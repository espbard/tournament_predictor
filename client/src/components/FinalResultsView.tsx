import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
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
  eyebrow?: string;
  subLabel?: string;
  pointsByUser: Record<string, number>;
  answerByUser?: Record<string, string>;
}

interface FinalResultsViewProps {
  users: DisplayUser[];
  pointSources: PointSource[];
  introText: string;
  winnerLabel: (name: string) => string;
  toLeaderboardLabel: string;
  closeLabel: string;
  onGoToLeaderboard: () => void;
}

const INTRO_MS = 4000;
const LABEL_MS = 1800;
const FALL_MS = 1000;
const PAUSE_MS = 900;

const BAR_COLOR_PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#10b981', '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6',
  '#a855f7', '#ec4899',
];

function wait(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

// Users with a custom photo don't have an "icon color" of their own, so their bar
// gets a random color that doesn't collide with any color already in use.
function assignBarColors(users: DisplayUser[]): Record<string, string> {
  const used = new Set<string>();
  const colors: Record<string, string> = {};

  for (const u of users) {
    if (!u.imageUrl) {
      const c = (u.iconColor ?? '#4b5563').toLowerCase();
      colors[u.userId] = c;
      used.add(c);
    }
  }

  for (const u of users) {
    if (u.imageUrl) {
      const available = BAR_COLOR_PALETTE.filter(c => !used.has(c.toLowerCase()));
      const pool = available.length > 0 ? available : BAR_COLOR_PALETTE;
      const chosen = pool[Math.floor(Math.random() * pool.length)];
      colors[u.userId] = chosen;
      used.add(chosen.toLowerCase());
    }
  }

  return colors;
}

export default function FinalResultsView({
  users,
  pointSources,
  introText,
  winnerLabel,
  toLeaderboardLabel,
  closeLabel,
  onGoToLeaderboard,
}: FinalResultsViewProps) {
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, []);

  const [showIntro, setShowIntro] = useState(true);
  const [sourceIdx, setSourceIdx] = useState(-1);
  const [phase, setPhase] = useState<'idle' | 'label' | 'falling' | 'landed'>('idle');
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [done, setDone] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);

  const barColors = useMemo(() => assignBarColors(users), [users]);

  useEffect(() => {
    if (pointSources.length === 0) return;
    let cancelled = false;

    async function run() {
      setShowIntro(true);
      setTotals({});
      setDone(false);
      setShowOverlay(false);
      await wait(INTRO_MS);
      if (cancelled) return;
      setShowIntro(false);
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
      if (!cancelled) {
        setPhase('idle');
        setDone(true);
        setShowOverlay(true);
      }
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

  // Left-to-right order follows current standing — ties keep their prior relative
  // order (stable sort + original-index tiebreaker) so nothing jitters at 0-0.
  const rankByUserId = useMemo(() => {
    const ranked = users
      .map((u, i) => ({ userId: u.userId, i, total: totals[u.userId] ?? 0 }))
      .sort((a, b) => b.total - a.total || a.i - b.i);
    const m = new Map<string, number>();
    ranked.forEach((u, idx) => m.set(u.userId, idx));
    return m;
  }, [users, totals]);

  const winner = useMemo(() => {
    if (!done || users.length === 0) return null;
    return [...users].sort((a, b) => (totals[b.userId] ?? 0) - (totals[a.userId] ?? 0) )[0];
  }, [done, users, totals]);

  const currentSource = sourceIdx >= 0 ? pointSources[sourceIdx] : null;
  const showHeader = currentSource !== null && (phase === 'label' || phase === 'falling' || phase === 'landed');
  const showFalling = currentSource !== null && phase === 'falling';
  const widthPct = users.length > 0 ? 100 / users.length : 100;

  return (
    <div className="fixed inset-0 z-[200] bg-black overflow-hidden">
      <div className="pointer-events-none absolute inset-0 animate-edge-pulse" />

      {showIntro ? (
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
          <p className="text-2xl font-bold leading-snug text-white sm:text-4xl md:text-5xl">{introText}</p>
        </div>
      ) : (
        <>
          <div
            className={`absolute inset-x-0 top-4 z-10 px-4 text-center transition-opacity duration-500 sm:top-6 ${
              showHeader ? 'opacity-100' : 'opacity-0'
            }`}
          >
            {currentSource?.eyebrow && (
              <div className="text-sm font-medium uppercase tracking-wide text-white/60 sm:text-lg">{currentSource.eyebrow}</div>
            )}
            <div className="text-xl font-semibold tracking-wide text-white sm:text-3xl">{currentSource?.label}</div>
            {currentSource?.subLabel && (
              <div className="mt-1 text-sm text-white/70 sm:text-lg">{currentSource.subLabel}</div>
            )}
          </div>

          <div className="absolute left-4 right-4 top-40 bottom-20 sm:left-8 sm:right-8 sm:top-44">
            {users.map(user => {
              const total = totals[user.userId] ?? 0;
              const pct = Math.min((total / maxTotal) * 100, 100);
              const sourcePoints = currentSource?.pointsByUser[user.userId] ?? 0;
              const sourceAnswer = currentSource?.answerByUser?.[user.userId];
              const color = barColors[user.userId] ?? '#4b5563';
              const rank = rankByUserId.get(user.userId) ?? 0;

              return (
                <div
                  key={user.userId}
                  className="absolute inset-y-0 flex flex-col items-center justify-end transition-[left] duration-700 ease-in-out"
                  style={{ left: `${rank * widthPct}%`, width: `${widthPct}%` }}
                >
                  {showFalling && (
                    <div
                      key={`${currentSource?.id}-fall`}
                      className="animate-points-fall absolute left-1/2 z-20 flex -translate-x-1/2 flex-col items-center whitespace-nowrap"
                    >
                      {sourceAnswer !== undefined && (
                        <span className="max-w-[90px] truncate text-[10px] text-white/80 sm:max-w-[120px] sm:text-xs">
                          {sourceAnswer || '—'}
                        </span>
                      )}
                      <span className={`text-sm font-bold sm:text-base ${sourcePoints > 0 ? 'text-green-400' : 'text-gray-500'}`}>
                        {sourcePoints > 0 ? `+${sourcePoints}` : '0'}
                      </span>
                    </div>
                  )}

                  <div className="flex w-full flex-1 items-end px-1 sm:px-1.5">
                    <div
                      className="w-full rounded-t-sm transition-[height] duration-700 ease-out"
                      style={{ height: `${pct}%`, background: `linear-gradient(to top, ${color}, ${color}99)` }}
                    />
                  </div>
                  <div className="mt-2 flex max-w-full flex-col items-center gap-1">
                    <UserAvatar
                      username={user.username}
                      imageUrl={user.imageUrl}
                      iconColor={user.iconColor}
                      className="h-8 w-8 sm:h-10 sm:w-10"
                      resizeWidth={96}
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
        </>
      )}

      {done && (
        <div className="absolute inset-x-0 bottom-4 z-[150] flex justify-center">
          <button
            onClick={onGoToLeaderboard}
            className="rounded-full bg-white/10 px-5 py-2 text-sm font-medium text-white backdrop-blur hover:bg-white/20 sm:text-base"
          >
            {toLeaderboardLabel}
          </button>
        </div>
      )}

      {showOverlay && winner && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 p-4">
          <div className="relative w-full max-w-sm rounded-xl border border-white/10 bg-neutral-900 p-6 text-center shadow-2xl">
            <button
              onClick={() => setShowOverlay(false)}
              aria-label={closeLabel}
              className="absolute right-3 top-3 text-white/60 hover:text-white"
            >
              <X size={20} />
            </button>
            <div className="mb-3 text-4xl">🏆</div>
            <UserAvatar
              username={winner.username}
              imageUrl={winner.imageUrl}
              iconColor={winner.iconColor}
              className="mx-auto h-16 w-16"
              resizeWidth={128}
            />
            <p className="mt-3 text-lg font-bold text-white">{winnerLabel(winner.username)}</p>
            <p className="text-sm text-white/60">{totals[winner.userId] ?? 0} pts</p>
          </div>
        </div>
      )}
    </div>
  );
}
