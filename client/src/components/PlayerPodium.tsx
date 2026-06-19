import { Link } from 'react-router-dom';
import type { LeaderboardEntry } from '@tournament-predictor/shared';
import { useT } from '@/lib/useT';

interface Props {
  leaderboard: LeaderboardEntry[];
  large?: boolean;
  competitionId?: string;
  tournamentStatus?: string;
}

function ordinal(rank: number): string {
  if (rank === 1) return '1st';
  if (rank === 2) return '2nd';
  if (rank === 3) return '3rd';
  return `${rank}th`;
}

function glowClass(rank: number): string {
  if (rank === 1) return 'animate-gold-glow';
  if (rank === 2) return 'glow-silver';
  return 'glow-bronze';
}

function avatarImg(entry: LeaderboardEntry, rank: number, sizeClass: string) {
  return (
    <img
      src={entry.imageUrl ?? '/default-avatar.png'}
      alt={entry.username}
      className={`rounded-full object-cover border-2 border-blue-500 ${glowClass(rank)} ${sizeClass}`}
    />
  );
}

function linkedAvatar(
  entry: LeaderboardEntry,
  rank: number,
  sizeClass: string,
  competitionId: string | undefined,
) {
  if (competitionId) {
    return (
      <Link
        to={`/competitions/${competitionId}/predictions/${entry.userId}`}
        className="hover:opacity-80 transition-opacity"
      >
        {avatarImg(entry, rank, sizeClass)}
      </Link>
    );
  }
  return avatarImg(entry, rank, sizeClass);
}

function renderWinnerFigure(
  entry: LeaderboardEntry,
  large: boolean,
  competitionId: string | undefined,
) {
  const figureHeight = large ? 'h-[396px]' : 'h-[216px]';
  const avatarSize = large ? 'h-[68px] w-[68px]' : 'h-[38px] w-[38px]';
  const nameClass = `font-medium text-center break-words w-full leading-tight ${large ? 'text-lg mb-3' : 'text-xs mb-2'}`;
  const wrapperClass = `flex flex-col items-center ${large ? 'mb-2 mt-4' : 'mb-1 mt-2'}`;

  const figure = (
    <div style={{ filter: 'drop-shadow(0 0 12px rgba(234, 179, 8, 0.75))' }}>
      <div className="relative inline-block overflow-hidden">
        <img src="/trophy-winner.png" alt="winner" className={`${figureHeight} w-auto object-contain scale-[1.6]`} />
        <img
          src={entry.imageUrl ?? '/default-avatar.png'}
          alt={entry.username}
          className={`absolute z-10 rounded-full object-cover ${avatarSize}`}
          style={{ top: 'calc(43% + 5px)', left: 'calc(50% + 7px)', transform: 'translate(-50%, -50%)' }}
        />
      </div>
    </div>
  );

  if (competitionId) {
    return (
      <Link
        to={`/competitions/${competitionId}/predictions/${entry.userId}`}
        className={`${wrapperClass} hover:opacity-80 transition-opacity`}
      >
        {figure}
        <p className={nameClass}>{entry.username}</p>
      </Link>
    );
  }
  return (
    <div className={wrapperClass}>
      {figure}
      <p className={nameClass}>{entry.username}</p>
    </div>
  );
}

function renderSlotAboveBar(
  group: LeaderboardEntry[],
  rank: number,
  large: boolean,
  competitionId: string | undefined,
  tournamentStatus?: string,
) {
  const count = group.length;
  const wrapperMargin = large ? 'mb-2 mt-14' : 'mb-1 mt-6';
  const singleSize = large ? 'h-20 w-20' : 'h-10 w-10';
  const triSize = large ? 'h-[60px] w-[60px]' : 'h-[30px] w-[30px]';
  const nameClass = `font-medium text-center break-words w-full leading-tight ${large ? 'text-lg mb-3' : 'text-xs mb-2'}`;
  const smallNameClass = `font-medium text-center break-words w-full leading-tight ${large ? 'text-sm mb-3' : 'text-[0.6rem] mb-2'}`;

  if (rank === 1 && count === 1 && tournamentStatus === 'completed') {
    return renderWinnerFigure(group[0], large, competitionId);
  }

  const crown = rank === 1 ? (
    <span
      className={`absolute left-1/2 -translate-x-1/2 select-none leading-none ${large ? '-top-12 text-4xl' : '-top-6 text-sm'}`}
      role="img"
      aria-label="crown"
    >
      👑
    </span>
  ) : null;

  if (count === 1) {
    const entry = group[0];
    if (competitionId) {
      return (
        <Link
          to={`/competitions/${competitionId}/predictions/${entry.userId}`}
          className={`flex flex-col items-center hover:opacity-80 transition-opacity ${wrapperMargin}`}
        >
          <div className="relative">
            {crown}
            {avatarImg(entry, rank, singleSize)}
          </div>
          <p className={nameClass}>{entry.username}</p>
        </Link>
      );
    }
    return (
      <>
        <div className={`relative ${wrapperMargin}`}>
          {crown}
          {avatarImg(entry, rank, singleSize)}
        </div>
        <p className={nameClass}>{entry.username}</p>
      </>
    );
  }

  if (count === 2) {
    return (
      <div className={`flex flex-col items-center ${wrapperMargin}`}>
        <div className="relative flex items-center justify-center">
          {crown}
          <div className={`flex items-center ${large ? 'gap-2' : 'gap-1'}`}>
            {group.map((entry) => (
              <div key={entry.userId}>
                {linkedAvatar(entry, rank, singleSize, competitionId)}
              </div>
            ))}
          </div>
        </div>
        <p className={nameClass}>{group[0].username} & {group[1].username}</p>
      </div>
    );
  }

  if (count === 3) {
    return (
      <div className={`flex flex-col items-center ${wrapperMargin}`}>
        <div className="relative flex flex-col items-center gap-0.5">
          {crown}
          <div className="flex justify-center">
            {linkedAvatar(group[0], rank, triSize, competitionId)}
          </div>
          <div className={`flex justify-center ${large ? 'gap-1' : 'gap-0.5'}`}>
            {linkedAvatar(group[1], rank, triSize, competitionId)}
            {linkedAvatar(group[2], rank, triSize, competitionId)}
          </div>
        </div>
        <p className={smallNameClass}>{group[0].username}, {group[1].username} and {group[2].username}</p>
      </div>
    );
  }

  // 4+ players: stacked icon effect with top player prominent
  return (
    <div className={`flex flex-col items-center ${wrapperMargin}`}>
      <div className="relative flex items-center justify-center">
        {crown}
        <div className="flex items-center">
          {group.slice(0, 3).map((entry, i) => {
            const img = avatarImg(entry, rank, singleSize);
            return (
              <div
                key={entry.userId}
                style={{
                  marginLeft: i === 0 ? 0 : large ? -24 : -12,
                  zIndex: 3 - i,
                  position: 'relative',
                }}
              >
                {i === 0 && competitionId ? (
                  <Link
                    to={`/competitions/${competitionId}/predictions/${entry.userId}`}
                    className="hover:opacity-80 transition-opacity"
                  >
                    {img}
                  </Link>
                ) : img}
              </div>
            );
          })}
        </div>
      </div>
      <p className={smallNameClass}>{group[0].username} +{count - 1} more</p>
    </div>
  );
}

export default function PlayerPodium({ leaderboard, large = false, competitionId, tournamentStatus }: Props) {
  const { t } = useT();

  const byRank = new Map<number, LeaderboardEntry[]>();
  for (const entry of leaderboard) {
    const group = byRank.get(entry.rank) ?? [];
    group.push(entry);
    byRank.set(entry.rank, group);
  }

  const uniqueRanks = Array.from(byRank.keys()).sort((a, b) => a - b);
  const rank1Group = byRank.get(uniqueRanks[0]) ?? [];
  const rank2Group = uniqueRanks[1] != null ? (byRank.get(uniqueRanks[1]) ?? []) : [];
  const rank3Group = uniqueRanks[2] != null ? (byRank.get(uniqueRanks[2]) ?? []) : [];

  if (rank1Group.length + rank2Group.length < 2) return null;

  let leftSlot: LeaderboardEntry[] | null;
  let rightSlot: LeaderboardEntry[] | null;
  const centerSlot = rank1Group;

  if (rank1Group.length >= 3) {
    leftSlot = null;
    rightSlot = null;
  } else if (rank1Group.length === 2) {
    leftSlot = null;
    rightSlot = rank2Group.length > 0 ? rank2Group : null;
  } else if (rank2Group.length >= 2) {
    leftSlot = rank2Group;
    rightSlot = null;
  } else {
    leftSlot = rank2Group.length > 0 ? rank2Group : null;
    rightSlot = rank3Group.length > 0 ? rank3Group : null;
  }

  const barHeights = large
    ? { 1: 160, 2: 116, 3: 92 }
    : { 1: 56, 2: 40, 3: 32 };

  const slotDefs: Array<{ group: LeaderboardEntry[] | null; fallbackRank: 1 | 2 | 3 }> = [
    { group: leftSlot, fallbackRank: 2 },
    { group: centerSlot, fallbackRank: 1 },
    { group: rightSlot, fallbackRank: 3 },
  ];

  return (
    <div className={`flex items-end justify-center ${large ? 'gap-6 pt-16 pb-2' : 'gap-3 pt-8 pb-0'}`}>
      {slotDefs.map(({ group, fallbackRank }, idx) => {
        const rank = group ? (group[0].rank as 1 | 2 | 3) : fallbackRank;
        const height = barHeights[rank];
        const colWidth = large ? 'w-44' : 'w-24';
        if (!group) return <div key={idx} className={colWidth} style={{ height }} />;
        return (
          <div key={`${rank}-${group.map(e => e.userId).join('-')}`} className={`flex flex-col items-center ${colWidth}`}>
            {renderSlotAboveBar(group, rank, large, competitionId, tournamentStatus)}
            <div className="w-full rounded-t-sm bg-blue-500 flex flex-col items-center justify-center gap-1" style={{ height }}>
              <span className={`text-white font-bold leading-none ${large ? 'text-2xl' : 'text-sm'}`}>{ordinal(rank)}</span>
              <span className={`text-white/80 leading-none ${large ? 'text-base' : 'text-xs'}`}>{group[0].totalPoints} {t('competitionDetail.leaderboard.points')}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
