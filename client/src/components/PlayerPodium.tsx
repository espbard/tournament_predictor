import { Link } from 'react-router-dom';
import type { LeaderboardEntry } from '@tournament-predictor/shared';
import { useT } from '@/lib/useT';

interface Props {
  leaderboard: LeaderboardEntry[];
  large?: boolean;
  competitionId?: string;
}

function ordinal(rank: number): string {
  if (rank === 1) return '1st';
  if (rank === 2) return '2nd';
  if (rank === 3) return '3rd';
  return `${rank}th`;
}

export default function PlayerPodium({ leaderboard, large = false, competitionId }: Props) {
  const { t } = useT();
  const top = leaderboard.slice(0, 3);
  if (top.length < 2) return null;

  const [first, second, third] = top;

  // Layout order: 2nd left, 1st centre, 3rd right
  const slots: Array<LeaderboardEntry | undefined> = [second, first, third];

  const barHeights = large
    ? { 1: 160, 2: 116, 3: 92 }
    : { 1: 56, 2: 40, 3: 32 };

  return (
    <div className={`flex items-end justify-center ${large ? 'gap-6 pt-16 pb-2' : 'gap-3 pt-8 pb-0'}`}>
      {slots.map((entry, idx) => {
        const height = barHeights[(entry?.rank ?? 3) as 1 | 2 | 3] ?? barHeights[3];
        if (!entry) {
          return <div key={idx} className={large ? 'w-44' : 'w-24'} style={{ height }} />;
        }
        return (
          <div key={entry.userId} className={`flex flex-col items-center ${large ? 'w-44' : 'w-24'}`}>
            {competitionId ? (
              <Link
                to={`/competitions/${competitionId}/predictions/${entry.userId}`}
                className={`flex flex-col items-center hover:opacity-80 transition-opacity ${large ? 'mb-2 mt-14' : 'mb-1 mt-6'}`}
              >
                <div className="relative">
                  {entry.rank === 1 && (
                    <span
                      className={`absolute left-1/2 -translate-x-1/2 select-none leading-none ${large ? '-top-12 text-4xl' : '-top-6 text-sm'}`}
                      role="img"
                      aria-label="crown"
                    >
                      👑
                    </span>
                  )}
                  <img
                    src={entry.imageUrl ?? '/default-avatar.png'}
                    alt={entry.username}
                    className={`rounded-full object-cover border-2 border-blue-500 ${entry.rank === 1 ? 'animate-gold-glow' : entry.rank === 2 ? 'glow-silver' : entry.rank === 3 ? 'glow-bronze' : ''} ${large ? 'h-20 w-20' : 'h-10 w-10'}`}
                  />
                </div>
                <p className={`font-medium text-center truncate w-full leading-tight ${large ? 'text-lg mb-3' : 'text-xs mb-2'}`}>
                  {entry.username}
                </p>
              </Link>
            ) : (
              <div className={`relative ${large ? 'mb-2 mt-14' : 'mb-1 mt-6'}`}>
                {entry.rank === 1 && (
                  <span
                    className={`absolute left-1/2 -translate-x-1/2 select-none leading-none ${large ? '-top-12 text-4xl' : '-top-6 text-sm'}`}
                    role="img"
                    aria-label="crown"
                  >
                    👑
                  </span>
                )}
                <img
                  src={entry.imageUrl ?? '/default-avatar.png'}
                  alt={entry.username}
                  className={`rounded-full object-cover border-2 border-blue-500 ${entry.rank === 1 ? 'animate-gold-glow' : entry.rank === 2 ? 'glow-silver' : entry.rank === 3 ? 'glow-bronze' : ''} ${large ? 'h-20 w-20' : 'h-10 w-10'}`}
                />
              </div>
            )}
            {!competitionId && (
              <p className={`font-medium text-center truncate w-full leading-tight ${large ? 'text-lg mb-3' : 'text-xs mb-2'}`}>
                {entry.username}
              </p>
            )}
            <div
              className="w-full rounded-t-sm bg-blue-500 flex flex-col items-center justify-center gap-1"
              style={{ height }}
            >
              <span className={`text-white font-bold leading-none ${large ? 'text-2xl' : 'text-sm'}`}>{ordinal(entry.rank)}</span>
              <span className={`text-white/80 leading-none ${large ? 'text-base' : 'text-xs'}`}>{entry.totalPoints} {t('competitionDetail.leaderboard.points')}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
