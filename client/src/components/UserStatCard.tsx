import { Link } from 'react-router-dom';
import type { UserStatCardData } from '@tournament-predictor/shared';

interface UserStatCardProps {
  competitionId: string;
  data: UserStatCardData;
  iconOnRight: boolean;
}

export default function UserStatCard({ competitionId, data, iconOnRight }: UserStatCardProps) {
  const { title, statistic, subjects } = data;

  const icon = (
    <div className="w-1/4 flex-shrink-0">
      {subjects.length > 1 ? (
        <div className="grid h-full w-full grid-cols-2">
          {subjects.map(subject => (
            <img
              key={subject.id}
              src={subject.imageUrl ?? '/default-avatar.png'}
              alt={subject.name}
              className="h-full w-full object-cover"
            />
          ))}
        </div>
      ) : (
        <img
          src={subjects[0]?.imageUrl ?? '/default-avatar.png'}
          alt={subjects[0]?.name ?? ''}
          className="h-full w-full object-cover"
        />
      )}
    </div>
  );

  const content = (
    <div className="min-w-0 flex-1 p-6">
      <h3 className="text-lg font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <p className="mt-2 text-sm">{statistic}</p>
    </div>
  );

  const card = (
    <div className={`flex h-40 items-stretch overflow-hidden rounded-2xl border bg-muted/50 ${iconOnRight ? 'flex-row-reverse' : 'flex-row'}`}>
      {icon}
      {content}
    </div>
  );

  if (subjects.length === 1 && subjects[0].type === 'user') {
    return (
      <Link
        to={`/competitions/${competitionId}/predictions/${subjects[0].id}`}
        className="block transition-opacity hover:opacity-80"
      >
        {card}
      </Link>
    );
  }

  return card;
}
