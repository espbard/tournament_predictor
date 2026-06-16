import { Link } from 'react-router-dom';
import type { UserStatCardData } from '@tournament-predictor/shared';

interface UserStatCardProps {
  competitionId: string;
  data: UserStatCardData;
  iconOnRight: boolean;
}

const SQUARE_CORNER_ANGLES = [45, 135, 225, 315];
const COLLAGE_GAP_DEGREES = 6;

function pointOnSquareAtAngle(angleDeg: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const t = 1 / Math.max(Math.abs(dx), Math.abs(dy), 1e-9);
  return { x: 50 + dx * t * 50, y: 50 + dy * t * 50 };
}

// Slices are trimmed by half the gap on each side, so every seam stays centred between its two neighbours.
function pieSliceClipPath(index: number, total: number, rotationOffset: number): string {
  const sliceAngle = 360 / total;
  const start = index * sliceAngle + rotationOffset + COLLAGE_GAP_DEGREES / 2;
  const end = (index + 1) * sliceAngle + rotationOffset - COLLAGE_GAP_DEGREES / 2;
  const points = [{ x: 50, y: 50 }, pointOnSquareAtAngle(start)];
  for (const corner of SQUARE_CORNER_ANGLES) {
    for (const k of [-1, 0, 1, 2]) {
      const angle = corner + k * 360;
      if (angle > start && angle < end) points.push(pointOnSquareAtAngle(angle));
    }
  }
  points.push(pointOnSquareAtAngle(end));
  return `polygon(${points.map(p => `${p.x}% ${p.y}%`).join(', ')})`;
}

function collageClipPath(index: number, total: number): string {
  // Rotating a 2-way split by 45 degrees turns the edge-to-edge cut into a corner-to-corner diagonal.
  const rotationOffset = total === 2 ? 45 : 0;
  return pieSliceClipPath(index, total, rotationOffset);
}

export default function UserStatCard({ competitionId, data, iconOnRight }: UserStatCardProps) {
  const { title, statistic, subjects } = data;

  const icon = (
    <div className="w-1/4 flex-shrink-0">
      {subjects.length > 1 ? (
        <div className="relative h-full w-full">
          {subjects.map((subject, i) => (
            <img
              key={subject.id}
              src={subject.imageUrl ?? '/default-avatar.png'}
              alt={subject.name}
              className="absolute inset-0 h-full w-full object-cover"
              style={{ clipPath: collageClipPath(i, subjects.length) }}
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
