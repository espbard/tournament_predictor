import { Link } from 'react-router-dom';
import type { UserStatCardData } from '@tournament-predictor/shared';
import { UserAvatar } from '@/components/UserAvatar';
import { useThemeStore } from '@/store/themeStore';

interface UserStatCardProps {
  competitionId: string;
  data: UserStatCardData;
  iconOnRight?: boolean;
  onMatchClick?: (matchId: string) => void;
  onLeaderboardClick?: () => void;
}

const LIGHT_TITLE   = 'hsl(231, 70%, 28%)';
const LIGHT_BOLD    = 'hsl(358, 70%, 32%)';
const LIGHT_TEXT    = 'hsl(180, 2%, 28%)';
const LIGHT_BORDER  = 'hsl(231, 70%, 28%)';

const DARK_TITLE    = 'hsl(231, 60%, 65%)';
const DARK_BOLD     = 'hsl(358, 55%, 62%)';
const DARK_TEXT     = 'hsl(120, 3%, 85%)';
const DARK_BORDER   = 'hsl(231, 40%, 28%)';

// Renders `**bold**` markers in stat text (e.g. usernames) as <strong> spans.
function renderStatistic(text: string, boldColor: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={i} style={{ color: boldColor }}>
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    )
  );
}

type Subject = UserStatCardData['subjects'][number];

function SubjectCell({ subject, className }: { subject: Subject; className: string }) {
  if (subject.type === 'user' && !subject.imageUrl) {
    return (
      <UserAvatar
        username={subject.name}
        imageUrl={subject.imageUrl}
        iconColor={subject.iconColor}
        className={className}
        style={{ borderRadius: 0 }}
      />
    );
  }
  return (
    <img
      src={subject.imageUrl ?? '/default-avatar.png'}
      alt={subject.name}
      className={`${className} object-cover`}
    />
  );
}

// Grid layouts per subject count (2–6).
// Each entry is an array of rows; each row has a slice range and column width class.
type RowDef = { from: number; to: number; colClass: string };

const GRID_LAYOUTS: Record<number, RowDef[][]> = {
  2: [[{ from: 0, to: 2, colClass: 'w-1/2' }]],
  3: [
    [{ from: 0, to: 2, colClass: 'w-1/2' }],
    [{ from: 2, to: 3, colClass: 'w-1/2' }],
  ],
  4: [
    [{ from: 0, to: 2, colClass: 'w-1/2' }],
    [{ from: 2, to: 4, colClass: 'w-1/2' }],
  ],
  5: [
    [{ from: 0, to: 3, colClass: 'w-1/3' }],
    [{ from: 3, to: 5, colClass: 'w-1/3' }],
  ],
  6: [
    [{ from: 0, to: 3, colClass: 'w-1/3' }],
    [{ from: 3, to: 6, colClass: 'w-1/3' }],
  ],
};

function CollageGrid({ subjects }: { subjects: Subject[] }) {
  const rows = GRID_LAYOUTS[subjects.length];
  const rowHeightClass = rows.length === 1 ? 'h-full' : 'h-1/2';

  return (
    <div className="flex flex-col h-full w-full">
      {rows.map((rowDefs, ri) => {
        const rowSubjects = subjects.slice(rowDefs[0].from, rowDefs[0].to);
        const colClass = rowDefs[0].colClass;
        return (
          <div key={ri} className={`flex ${rowHeightClass} justify-center`}>
            {rowSubjects.map(subject => (
              <div key={subject.id} className={`${colClass} h-full overflow-hidden`}>
                <SubjectCell subject={subject} className="h-full w-full" />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export default function UserStatCard({ competitionId, data, onMatchClick, onLeaderboardClick }: UserStatCardProps) {
  const { title, statistic, subjects } = data;
  const isDark = useThemeStore((s) => s.theme === 'dark');
  const titleColor  = isDark ? DARK_TITLE  : LIGHT_TITLE;
  const boldColor   = isDark ? DARK_BOLD   : LIGHT_BOLD;
  const textColor   = isDark ? DARK_TEXT   : LIGHT_TEXT;
  const borderColor = isDark ? DARK_BORDER : LIGHT_BORDER;

  // 7+ subjects: show only the first one
  const displaySubjects = subjects.length >= 7 ? subjects.slice(0, 1) : subjects;
  const hasImage = !!(data.iconImageUrl || data.backgroundImageUrl || displaySubjects.length > 0);

  const avatarSize = displaySubjects.length === 1 ? 'w-20 h-20' : displaySubjects.length <= 3 ? 'w-16 h-16' : 'w-12 h-12';

  const image = hasImage && (
    <div className="relative h-44 w-full flex-shrink-0">
      {data.backgroundImageUrl ? (
        <>
          <img src={data.backgroundImageUrl} alt="" className="absolute inset-0 h-full w-full object-contain p-4" />
          <div className="absolute inset-0 flex items-center justify-center gap-2" style={{ zIndex: 1 }}>
            {displaySubjects.map(subject =>
              subject.type === 'user' ? (
                <UserAvatar
                  key={subject.id}
                  username={subject.name}
                  imageUrl={subject.imageUrl}
                  iconColor={subject.iconColor}
                  className={`${avatarSize} ring-2 ring-white shadow-lg`}
                />
              ) : (
                <img
                  key={subject.id}
                  src={subject.imageUrl ?? '/default-avatar.png'}
                  alt={subject.name}
                  className={`${avatarSize} rounded-full object-cover ring-2 ring-white shadow-lg`}
                />
              )
            )}
          </div>
        </>
      ) : data.iconImageUrl ? (
        <img src={data.iconImageUrl} alt="" className="h-full w-full object-contain p-4" />
      ) : displaySubjects.length > 1 ? (
        <CollageGrid subjects={displaySubjects} />
      ) : displaySubjects[0]?.type === 'user' && !displaySubjects[0]?.imageUrl ? (
        <UserAvatar
          username={displaySubjects[0].name}
          imageUrl={displaySubjects[0].imageUrl}
          iconColor={displaySubjects[0].iconColor}
          className="h-full w-full"
          style={{ borderRadius: 0 }}
        />
      ) : (
        <img
          src={displaySubjects[0]?.imageUrl ?? '/default-avatar.png'}
          alt={displaySubjects[0]?.name ?? ''}
          className="h-full w-full object-cover"
        />
      )}
      {data.overlayImageUrl && !data.backgroundImageUrl && (
        <img
          src={data.overlayImageUrl}
          alt=""
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-40"
        />
      )}
    </div>
  );

  const card = (
    <div className="relative">
      <div
        className="overflow-hidden rounded-2xl border dark:border bg-[hsla(120,3%,91%,0.5)] dark:bg-[hsl(231,28%,16%)]"
        style={{ color: textColor, borderColor }}
      >
        {image}
        <div className="px-4 pt-3 pb-0">
          <h3 className="text-lg font-bold uppercase tracking-wide text-center" style={{ color: titleColor }}>
            {title}
          </h3>
        </div>
        <div className="px-4 pt-1.5 pb-4">
          <p className="text-sm">{renderStatistic(statistic, boldColor)}</p>
        </div>
      </div>
      {data.id === 'theLeader' && (
        <span
          className="absolute -top-3 -right-2 text-3xl leading-none select-none pointer-events-none z-10"
          style={{ transform: 'rotate(15deg)' }}
        >
          👑
        </span>
      )}
    </div>
  );

  if (data.linkType === 'match' && data.matchId) {
    const matchId = data.matchId;
    return (
      <button
        type="button"
        onClick={() => onMatchClick?.(matchId)}
        className="block w-full text-left transition-opacity hover:opacity-80"
      >
        {card}
      </button>
    );
  }

  if (data.linkType === 'leaderboard') {
    return (
      <button
        type="button"
        onClick={() => onLeaderboardClick?.()}
        className="block w-full text-left transition-opacity hover:opacity-80"
      >
        {card}
      </button>
    );
  }

  if (data.linkType === 'user' && subjects.length > 0) {
    return (
      <Link
        to={`/competitions/${competitionId}/predictions/${subjects[0].id}`}
        className="block transition-opacity hover:opacity-80"
      >
        {card}
      </Link>
    );
  }

  if (data.linkType === 'userBonus' && subjects.length > 0) {
    return (
      <Link
        to={`/competitions/${competitionId}/predictions/${subjects[0].id}?tab=bonus`}
        className="block transition-opacity hover:opacity-80"
      >
        {card}
      </Link>
    );
  }

  return card;
}
