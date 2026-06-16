import { Link } from 'react-router-dom';
import type { UserStatCardData } from '@tournament-predictor/shared';

interface UserStatCardProps {
  competitionId: string;
  data: UserStatCardData;
  iconOnRight: boolean;
  onMatchClick?: (matchId: string) => void;
  onLeaderboardClick?: () => void;
}

type Point = { x: number; y: number };
type Vector = { dx: number; dy: number };

const SQUARE_CORNER_ANGLES = [45, 135, 225, 315];
const COLLAGE_GAP_PERCENT = 4;

function pointOnSquareAtAngle(angleDeg: number): Point {
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const t = 1 / Math.max(Math.abs(dx), Math.abs(dy), 1e-9);
  return { x: 50 + dx * t * 50, y: 50 + dy * t * 50 };
}

// The outward radial direction at a given angle (0deg = up, clockwise positive).
function radialUnit(angleDeg: number): Vector {
  const rad = (angleDeg * Math.PI) / 180;
  return { dx: Math.sin(rad), dy: -Math.cos(rad) };
}

// The direction perpendicular to radialUnit, pointing towards increasing angle.
function tangentUnit(angleDeg: number): Vector {
  const rad = (angleDeg * Math.PI) / 180;
  return { dx: Math.cos(rad), dy: Math.sin(rad) };
}

// Finds where a ray from `origin` in direction `dir` first crosses the 0-100% square boundary.
function intersectSquareBoundary(origin: Point, dir: Vector): Point {
  let bestT = Infinity;
  const candidateTs: number[] = [];
  if (Math.abs(dir.dx) > 1e-9) candidateTs.push((0 - origin.x) / dir.dx, (100 - origin.x) / dir.dx);
  if (Math.abs(dir.dy) > 1e-9) candidateTs.push((0 - origin.y) / dir.dy, (100 - origin.y) / dir.dy);
  for (const t of candidateTs) {
    if (t <= 1e-6) continue;
    const x = origin.x + t * dir.dx;
    const y = origin.y + t * dir.dy;
    if (x >= -1e-6 && x <= 100.000001 && y >= -1e-6 && y <= 100.000001 && t < bestT) bestT = t;
  }
  return { x: origin.x + bestT * dir.dx, y: origin.y + bestT * dir.dy };
}

function intersectLines(o1: Point, d1: Vector, o2: Point, d2: Vector): Point {
  const denom = d1.dx * d2.dy - d1.dy * d2.dx;
  const t = ((o2.x - o1.x) * d2.dy - (o2.y - o1.y) * d2.dx) / denom;
  return { x: o1.x + t * d1.dx, y: o1.y + t * d1.dy };
}

// Each slice edge is the original radial cut shifted sideways by half the gap, so the seam
// between two images keeps the same perpendicular width along its whole length, not just near
// the outer edge.
function pieSlicePoints(index: number, total: number, rotationOffset: number): Point[] {
  const sliceAngle = 360 / total;
  const start = index * sliceAngle + rotationOffset;
  const end = start + sliceAngle;
  const halfGap = COLLAGE_GAP_PERCENT / 2;
  const center: Point = { x: 50, y: 50 };
  const tangentStart = tangentUnit(start);
  const tangentEnd = tangentUnit(end);
  const originStart = { x: center.x + halfGap * tangentStart.dx, y: center.y + halfGap * tangentStart.dy };
  const originEnd = { x: center.x - halfGap * tangentEnd.dx, y: center.y - halfGap * tangentEnd.dy };
  const dirStart = radialUnit(start);
  const dirEnd = radialUnit(end);
  // A slice spanning exactly 180 degrees has antiparallel edges (the same line on both sides
  // of the centre), so the two shifted origins already coincide instead of forming a real
  // intersection.
  const innerVertex = sliceAngle === 180 ? originStart : intersectLines(originStart, dirStart, originEnd, dirEnd);
  const outerStart = intersectSquareBoundary(originStart, dirStart);
  const outerEnd = intersectSquareBoundary(originEnd, dirEnd);

  const points = [innerVertex, outerStart];
  for (const corner of SQUARE_CORNER_ANGLES) {
    for (const k of [-1, 0, 1, 2]) {
      const angle = corner + k * 360;
      if (angle > start && angle < end) points.push(pointOnSquareAtAngle(angle));
    }
  }
  points.push(outerEnd);
  return points;
}

interface SliceLayout {
  clipPath: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

// Sizes and positions the image to its slice's own bounding box (instead of the full collage
// square), so object-cover centres the image on the slice rather than on the whole collage.
function collageSliceLayout(index: number, total: number): SliceLayout {
  // Rotating a 2-way split by 45 degrees turns the edge-to-edge cut into a corner-to-corner diagonal.
  const rotationOffset = total === 2 ? 45 : 0;
  const points = pieSlicePoints(index, total, rotationOffset);

  const minX = Math.min(...points.map(p => p.x));
  const maxX = Math.max(...points.map(p => p.x));
  const minY = Math.min(...points.map(p => p.y));
  const maxY = Math.max(...points.map(p => p.y));
  const width = maxX - minX;
  const height = maxY - minY;

  const clipPath = `polygon(${points
    .map(p => `${((p.x - minX) / width) * 100}% ${((p.y - minY) / height) * 100}%`)
    .join(', ')})`;

  return { clipPath, left: minX, top: minY, width, height };
}

const DARK_BLUE = 'hsl(231, 70%, 28%)';

// Renders `**bold**` markers in stat text (e.g. usernames) as <strong> spans.
function renderStatistic(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={i} style={{ color: DARK_BLUE }}>
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    )
  );
}

export default function UserStatCard({ competitionId, data, iconOnRight, onMatchClick, onLeaderboardClick }: UserStatCardProps) {
  const { title, statistic, subjects } = data;

  const icon = (
    <div className="relative min-h-40 w-1/3 flex-shrink-0 sm:w-1/4">
      {subjects.length > 1 ? (
        <div className="relative h-full w-full">
          {subjects.map((subject, i) => {
            const layout = collageSliceLayout(i, subjects.length);
            return (
              <img
                key={subject.id}
                src={subject.imageUrl ?? '/default-avatar.png'}
                alt={subject.name}
                className="absolute object-cover"
                style={{
                  left: `${layout.left}%`,
                  top: `${layout.top}%`,
                  width: `${layout.width}%`,
                  height: `${layout.height}%`,
                  clipPath: layout.clipPath,
                }}
              />
            );
          })}
        </div>
      ) : (
        <img
          src={subjects[0]?.imageUrl ?? '/default-avatar.png'}
          alt={subjects[0]?.name ?? ''}
          className="h-full w-full object-cover"
        />
      )}
      {data.overlayImageUrl && (
        <img
          src={data.overlayImageUrl}
          alt=""
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-40"
        />
      )}
    </div>
  );

  const content = (
    <div className="min-w-0 flex-1 p-6">
      <h3 className="text-lg font-semibold uppercase tracking-wide" style={{ color: DARK_BLUE }}>
        {title}
      </h3>
      <p className="mt-2 text-sm">{renderStatistic(statistic)}</p>
    </div>
  );

  const card = (
    <div
      className={`flex items-stretch overflow-hidden rounded-2xl border bg-[hsla(120,3%,91%,0.5)] dark:bg-[hsl(120,3%,91%)] ${iconOnRight ? 'flex-row-reverse' : 'flex-row'}`}
      style={{ color: 'hsl(180, 2%, 28%)', borderColor: DARK_BLUE }}
    >
      {icon}
      {content}
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

  return card;
}
