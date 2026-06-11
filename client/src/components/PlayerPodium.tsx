import type { LeaderboardEntry } from '@tournament-predictor/shared';

interface Props {
  leaderboard: LeaderboardEntry[];
}

function ordinal(rank: number): string {
  if (rank === 1) return '1st';
  if (rank === 2) return '2nd';
  if (rank === 3) return '3rd';
  return `${rank}th`;
}

function barHeight(rank: number): number {
  if (rank === 1) return 56;
  if (rank === 2) return 40;
  return 32;
}

export default function PlayerPodium({ leaderboard }: Props) {
  const top = leaderboard.slice(0, 3);
  if (top.length < 2) return null;

  const [first, second, third] = top;

  // Layout order: 2nd left, 1st centre, 3rd right
  const slots: Array<LeaderboardEntry | undefined> = [second, first, third];

  return (
    <div className="flex items-end justify-center gap-3 pt-8 pb-0">
      {slots.map((entry, idx) => {
        if (!entry) {
          return <div key={idx} className="w-24" style={{ height: barHeight(3) }} />;
        }
        const height = barHeight(entry.rank);
        return (
          <div key={entry.userId} className="flex flex-col items-center w-24">
            <div className="relative mb-1">
              {entry.rank === 1 && (
                <span
                  className="absolute -top-4 left-1/2 -translate-x-1/2 text-sm leading-none select-none"
                  role="img"
                  aria-label="crown"
                >
                  👑
                </span>
              )}
              <img
                src={entry.imageUrl ?? '/default-avatar.png'}
                alt={entry.username}
                className="h-10 w-10 rounded-full object-cover border-2 border-blue-500"
              />
            </div>
            <p className="text-xs font-medium text-center truncate w-full mb-2 leading-tight">
              {entry.username}
            </p>
            <div
              className="w-full rounded-t-sm bg-blue-500 flex flex-col items-center justify-center gap-0.5"
              style={{ height }}
            >
              <span className="text-white font-bold text-sm leading-none">{ordinal(entry.rank)}</span>
              <span className="text-white/80 text-xs leading-none">{entry.totalPoints}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
