import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { LeaderboardEntry } from '@tournament-predictor/shared';
import { useT } from '@/lib/useT';
import { UserAvatar } from '@/components/UserAvatar';

interface Props {
  leaderboard: LeaderboardEntry[];
  large?: boolean;
  competitionId?: string;
  tournamentStatus?: string;
}

// Three size tiers: 'sm' is the default (mobile/tablet) look, 'lg' is used on wider
// desktop/laptop viewports for the regular leaderboard page, and 'tv' is the dedicated
// large-screen TV kiosk view (driven by the `large` prop, independent of viewport width).
type Tier = 'sm' | 'lg' | 'tv';

const SIZES: Record<Tier, {
  figureHeight: string;
  winnerAvatar: string;
  wrapperMargin: string;
  slotWrapperMargin: string;
  nameClass: string;
  smallNameClass: string;
  singleSize: string;
  triSize: string;
  crownPos: string;
  pairGap: string;
  triGap: string;
  stackOverlap: number;
  barHeights: { 1: number; 2: number; 3: number };
  colWidth: string;
  containerGap: string;
  ordinalClass: string;
  pointsClass: string;
}> = {
  sm: {
    figureHeight: 'h-[216px]',
    winnerAvatar: 'h-[38px] w-[38px]',
    wrapperMargin: 'mb-1 mt-2',
    slotWrapperMargin: 'mb-1 mt-6',
    nameClass: 'text-xs mb-2',
    smallNameClass: 'text-[0.6rem] mb-2',
    singleSize: 'h-10 w-10',
    triSize: 'h-[30px] w-[30px]',
    crownPos: '-top-6 text-sm',
    pairGap: 'gap-1',
    triGap: 'gap-0.5',
    stackOverlap: -12,
    barHeights: { 1: 56, 2: 40, 3: 32 },
    colWidth: 'w-24',
    containerGap: 'gap-3 pt-8 pb-0',
    ordinalClass: 'text-sm',
    pointsClass: 'text-xs',
  },
  lg: {
    figureHeight: 'h-[340px]',
    winnerAvatar: 'h-[58px] w-[58px]',
    wrapperMargin: 'mb-2 mt-4',
    slotWrapperMargin: 'mb-2 mt-12',
    nameClass: 'text-lg mb-3',
    smallNameClass: 'text-sm mb-3',
    singleSize: 'h-[72px] w-[72px]',
    triSize: 'h-[52px] w-[52px]',
    crownPos: '-top-11 text-4xl',
    pairGap: 'gap-2',
    triGap: 'gap-1',
    stackOverlap: -22,
    barHeights: { 1: 144, 2: 104, 3: 82 },
    colWidth: 'w-40',
    containerGap: 'gap-5 pt-14 pb-1',
    ordinalClass: 'text-2xl',
    pointsClass: 'text-base',
  },
  tv: {
    figureHeight: 'h-[396px]',
    winnerAvatar: 'h-[68px] w-[68px]',
    wrapperMargin: 'mb-2 mt-4',
    slotWrapperMargin: 'mb-2 mt-14',
    nameClass: 'text-lg mb-3',
    smallNameClass: 'text-sm mb-3',
    singleSize: 'h-20 w-20',
    triSize: 'h-[60px] w-[60px]',
    crownPos: '-top-12 text-4xl',
    pairGap: 'gap-2',
    triGap: 'gap-1',
    stackOverlap: -24,
    barHeights: { 1: 160, 2: 116, 3: 92 },
    colWidth: 'w-44',
    containerGap: 'gap-6 pt-16 pb-2',
    ordinalClass: 'text-2xl',
    pointsClass: 'text-base',
  },
};

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
    <UserAvatar
      username={entry.username}
      imageUrl={entry.imageUrl}
      iconColor={entry.iconColor}
      className={`rounded-full border-2 border-blue-500 ${glowClass(rank)} ${sizeClass}`}
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
  tier: Tier,
  competitionId: string | undefined,
) {
  const s = SIZES[tier];
  const nameClass = `font-medium text-center break-words w-full leading-tight ${s.nameClass}`;
  const wrapperClass = `flex flex-col items-center ${s.wrapperMargin}`;

  const figure = (
    <div style={{ filter: 'drop-shadow(0 0 12px rgba(234, 179, 8, 0.75))' }}>
      <div className="relative inline-block overflow-hidden">
        <img src="/trophy-winner.png" alt="winner" className={`${s.figureHeight} w-auto object-contain scale-[1.6]`} />
        <UserAvatar
          username={entry.username}
          imageUrl={entry.imageUrl}
          iconColor={entry.iconColor}
          className={`absolute z-10 rounded-full ${s.winnerAvatar}`}
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
  tier: Tier,
  competitionId: string | undefined,
  tournamentStatus?: string,
) {
  const s = SIZES[tier];
  const count = group.length;
  const wrapperMargin = s.slotWrapperMargin;
  const singleSize = s.singleSize;
  const triSize = s.triSize;
  const nameClass = `font-medium text-center break-words w-full leading-tight ${s.nameClass}`;
  const smallNameClass = `font-medium text-center break-words w-full leading-tight ${s.smallNameClass}`;

  if (rank === 1 && count === 1 && tournamentStatus === 'completed') {
    return renderWinnerFigure(group[0], tier, competitionId);
  }

  const crown = rank === 1 ? (
    <span
      className={`absolute left-1/2 -translate-x-1/2 select-none leading-none ${s.crownPos}`}
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
          <div className={`flex items-center ${s.pairGap}`}>
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
          <div className={`flex justify-center ${s.triGap}`}>
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
                  marginLeft: i === 0 ? 0 : s.stackOverlap,
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

  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia('(min-width: 1024px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const fn = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);

  const tier: Tier = large ? 'tv' : isDesktop ? 'lg' : 'sm';
  const s = SIZES[tier];

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

  const barHeights = s.barHeights;

  const slotDefs: Array<{ group: LeaderboardEntry[] | null; fallbackRank: 1 | 2 | 3 }> = [
    { group: leftSlot, fallbackRank: 2 },
    { group: centerSlot, fallbackRank: 1 },
    { group: rightSlot, fallbackRank: 3 },
  ];

  return (
    <div className={`flex items-end justify-center ${s.containerGap}`}>
      {slotDefs.map(({ group, fallbackRank }, idx) => {
        const rank = group ? (group[0].rank as 1 | 2 | 3) : fallbackRank;
        const height = barHeights[rank];
        const colWidth = s.colWidth;
        if (!group) return <div key={idx} className={colWidth} style={{ height }} />;
        return (
          <div key={`${rank}-${group.map(e => e.userId).join('-')}`} className={`flex flex-col items-center ${colWidth}`}>
            {renderSlotAboveBar(group, rank, tier, competitionId, tournamentStatus)}
            <div className="w-full rounded-t-sm bg-blue-500 flex flex-col items-center justify-center gap-1" style={{ height }}>
              <span className={`text-white font-bold leading-none ${s.ordinalClass}`}>{ordinal(rank)}</span>
              <span className={`text-white/80 leading-none ${s.pointsClass}`}>{group[0].totalPoints} {t('competitionDetail.leaderboard.points')}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
