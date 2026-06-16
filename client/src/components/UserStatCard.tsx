import { Link } from 'react-router-dom';
import type { UserStatCardData } from '@tournament-predictor/shared';

interface UserStatCardProps {
  competitionId: string;
  data: UserStatCardData;
  iconOnRight: boolean;
}

export default function UserStatCard({ competitionId, data, iconOnRight }: UserStatCardProps) {
  const { title, statistic, subject } = data;

  const icon = (
    <div className="w-1/4 flex-shrink-0 flex items-center justify-center bg-muted/50 p-3">
      <img
        src={subject?.imageUrl ?? '/default-avatar.png'}
        alt={subject?.name ?? ''}
        className="h-14 w-14 rounded-full object-cover"
      />
    </div>
  );

  const content = (
    <div className="min-w-0 flex-1 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <p className="mt-1 text-sm">{statistic}</p>
    </div>
  );

  const card = (
    <div className={`flex items-stretch overflow-hidden rounded-lg border ${iconOnRight ? 'flex-row-reverse' : 'flex-row'}`}>
      {icon}
      {content}
    </div>
  );

  if (subject?.type === 'user') {
    return (
      <Link
        to={`/competitions/${competitionId}/predictions/${subject.id}`}
        className="block transition-opacity hover:opacity-80"
      >
        {card}
      </Link>
    );
  }

  return card;
}
