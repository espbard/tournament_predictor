import type { LeaderboardEntry } from '@tournament-predictor/shared';

interface Props {
  leaderboard: LeaderboardEntry[];
}

export default function PlayerPodium({ leaderboard }: Props) {
  const top = leaderboard.slice(0, 3);
  if (top.length < 2) return null;

  const [first, second, third] = top;

  // Layout: 2nd left, 1st centre, 3rd right
  const slots: Array<{ entry: LeaderboardEntry | undefined; rank: number; barHeight: number }> = [
    { entry: second, rank: 2, barHeight: 40 },
    { entry: first,  rank: 1, barHeight: 56 },
    { entry: third,  rank: 3, barHeight: 32 },
  ];

  return (
    <div className="flex items-end justify-center gap-3 pt-8 pb-0">
      {slots.map(({ entry, rank, barHeight }) => (
        <div key={rank} className="flex flex-col items-center w-24">
          {entry ? (
            <>
              <div className="relative mb-1">
                {rank === 1 && (
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
            </>
          ) : (
            <div className="h-[68px]" />
          )}
          <div
            className="w-full rounded-t-sm bg-blue-500 flex items-center justify-center"
            style={{ height: barHeight }}
          >
            <span className="text-white font-bold text-sm">{rank}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
