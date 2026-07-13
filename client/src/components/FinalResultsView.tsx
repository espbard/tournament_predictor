import { useEffect } from 'react';
import { UserAvatar } from '@/components/UserAvatar';
import type { LeaderboardEntry } from '@tournament-predictor/shared';

interface FinalResultsViewProps {
  leaderboard: LeaderboardEntry[];
}

const MAX_USERS = 20;

export default function FinalResultsView({ leaderboard }: FinalResultsViewProps) {
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, []);

  const users = leaderboard
    .filter(e => !e.isComparisonUser)
    .slice(0, MAX_USERS);

  return (
    <div className="fixed inset-0 z-[200] bg-black overflow-hidden">
      <div className="pointer-events-none absolute inset-0 animate-edge-pulse" />
      <div className="relative flex h-full w-full items-end justify-center gap-1 px-4 pb-8 pt-16 sm:gap-2 sm:px-8">
        {users.map(entry => (
          <div key={entry.userId} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end">
            <div className="flex w-full flex-1 items-end">
              <div className="w-full rounded-t-sm bg-gradient-to-t from-primary to-primary/60" style={{ height: '0%' }} />
            </div>
            <div className="mt-2 flex max-w-full flex-col items-center gap-1">
              <UserAvatar
                username={entry.username}
                imageUrl={entry.imageUrl}
                iconColor={entry.iconColor}
                className="h-8 w-8 sm:h-10 sm:w-10"
              />
              <span className="max-w-full truncate text-[10px] font-medium text-white sm:text-xs">
                {entry.username}
              </span>
              <span className="text-xs font-bold text-white sm:text-sm">0</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
