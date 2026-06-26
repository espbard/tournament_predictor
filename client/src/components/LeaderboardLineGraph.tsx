import { useState, useRef, useEffect, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { LeaderboardProgressionResponse } from '@tournament-predictor/shared';
import { useT } from '@/lib/useT';
import { ZoomIn, ZoomOut } from 'lucide-react';

const COLORS = [
  '#6366f1', '#f59e0b', '#10b981', '#ef4444', '#3b82f6',
  '#ec4899', '#14b8a6', '#f97316', '#8b5cf6', '#84cc16',
];

const ICON_R = 8;
const TOOLTIP_MAX = 6;
const MIN_WINDOW = 5;
const ZOOM_STEP = 5;
const ANIMATION_MS = 300;

function ease(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

interface FrozenEntry {
  userId: string;
  value: number;
  stroke: string;
}

interface FrozenTooltip {
  matchLabel: string;
  entries: FrozenEntry[];
}

interface Props {
  data: LeaderboardProgressionResponse;
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return isMobile;
}

export default function LeaderboardLineGraph({ data }: Props) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [hiddenUsers, setHiddenUsers] = useState<Set<string>>(new Set());
  const [frozenTooltip, setFrozenTooltip] = useState<FrozenTooltip | null>(null);
  const [suppressTooltip, setSuppressTooltip] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const matchCount = data.matches.length;

  const chartData = [
    ...data.matches.map((m, i) => {
      const point: Record<string, string | number> = { matchIndex: i + 1, matchLabel: m.label };
      for (const u of data.users) point[u.userId] = m.cumulativePoints[u.userId] ?? 0;
      return point;
    }),
    (() => {
      const last = data.matches[matchCount - 1];
      const point: Record<string, string | number> = { matchIndex: matchCount + 1, matchLabel: '' };
      for (const u of data.users) point[u.userId] = last?.cumulativePoints[u.userId] ?? 0;
      return point;
    })(),
  ];

  // --- Zoom: animate windowSize, slice chartData ---
  const [windowSize, setWindowSize] = useState(Math.min(25, matchCount));
  const animWindowRef = useRef(Math.min(25, matchCount));
  const [animWindow, setAnimWindow] = useState(Math.min(25, matchCount));
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const from = animWindowRef.current;
    const to = Math.min(windowSize, matchCount);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - start) / ANIMATION_MS, 1);
      const current = from + (to - from) * ease(t);
      animWindowRef.current = current;
      setAnimWindow(current);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [windowSize, matchCount]);

  // Slice to the animated window (rounded to whole matches)
  const displayData = chartData.slice(Math.max(0, matchCount - Math.round(animWindow)));
  const sentinelIndex = displayData.length - 1;

  // Y-axis minimum from the currently displayed data
  const visibleRealData = displayData.filter(d => (d.matchIndex as number) <= matchCount);
  const allVisibleValues = visibleRealData.flatMap(d =>
    data.users
      .filter(u => !hiddenUsers.has(u.userId))
      .map(u => (d[u.userId] as number) ?? 0),
  );
  const minVisible = allVisibleValues.length > 0 ? Math.min(...allVisibleValues) : 0;
  const yDomainMin = Math.round(animWindow) >= matchCount ? 0 : Math.max(0, minVisible - 5);

  const canZoomIn = windowSize > MIN_WINDOW;
  const canZoomOut = windowSize < matchCount;
  const zoomIn = () => setWindowSize(p => Math.max(MIN_WINDOW, p - ZOOM_STEP));
  const zoomOut = () => setWindowSize(p => Math.min(matchCount, p + ZOOM_STEP));

  const toggleUser = (userId: string) => {
    setHiddenUsers(prev => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      return next;
    });
  };

  const toggleAll = () => {
    setHiddenUsers(prev =>
      prev.size === 0 ? new Set(data.users.map(u => u.userId)) : new Set(),
    );
  };

  const handleChartClick = useCallback((state: {
    activePayload?: Array<{ dataKey?: unknown; value?: unknown; stroke?: unknown }>;
    activeLabel?: unknown;
  } | null) => {
    setSuppressTooltip(false);
    if (!state?.activePayload?.length) { setFrozenTooltip(null); return; }
    const matchIndex = state.activeLabel as number;
    if (matchIndex > matchCount) return;
    const matchLabel = (displayData.find(d => d.matchIndex === matchIndex)?.matchLabel as string) ?? String(matchIndex);
    const entries: FrozenEntry[] = state.activePayload
      .filter(p => !hiddenUsers.has(p.dataKey as string))
      .map(p => ({
        userId: p.dataKey as string,
        value: typeof p.value === 'number' ? p.value : Number(p.value ?? 0),
        stroke: typeof p.stroke === 'string' ? p.stroke : '',
      }))
      .sort((a, b) => b.value - a.value);
    setFrozenTooltip({ matchLabel, entries });
  }, [displayData, hiddenUsers, matchCount]);

  useEffect(() => {
    const dismiss = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFrozenTooltip(null);
        setSuppressTooltip(true);
      }
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, []);

  // Hover tooltip only — the frozen tooltip is a separate absolutely-positioned div.
  // Recharts' own wrapper is hidden via wrapperStyle when frozen so it can't drift.
  const renderTooltip = ({
    active,
    payload,
    label,
  }: {
    active?: boolean;
    payload?: ReadonlyArray<{ dataKey?: unknown; value?: unknown; stroke?: unknown }>;
    label?: unknown;
  }) => {
    if (frozenTooltip || suppressTooltip) return null;
    const matchIndex = label as number;
    if (!active || !payload?.length || matchIndex > matchCount) return null;
    const matchLabel = (displayData.find(d => d.matchIndex === matchIndex)?.matchLabel as string) ?? String(matchIndex);
    const sorted = [...payload]
      .filter(p => !hiddenUsers.has(p.dataKey as string))
      .sort((a, b) => (b.value as number) - (a.value as number));
    const visible = sorted.slice(0, TOOLTIP_MAX);
    const hasMore = sorted.length > TOOLTIP_MAX;
    return (
      <div className="rounded-lg border bg-background p-2 text-xs shadow-md min-w-[120px]">
        <p className="font-semibold mb-1 text-foreground">{matchLabel}</p>
        {visible.map(p => {
          const u = data.users.find(u => u.userId === p.dataKey);
          const strokeColor = typeof p.stroke === 'string' ? p.stroke : undefined;
          const ptValue = typeof p.value === 'number' ? p.value : Number(p.value ?? 0);
          return (
            <div key={p.dataKey as string} className="flex items-center gap-1.5 py-0.5">
              <span style={{ color: strokeColor }}>■</span>
              <span className="text-muted-foreground flex-1">{u?.username ?? String(p.dataKey ?? '')}</span>
              <span className="font-bold text-foreground">{ptValue}</span>
            </div>
          );
        })}
        {hasMore && <div className="text-muted-foreground py-0.5 pl-4">...</div>}
      </div>
    );
  };

  return (
    <div ref={containerRef}>
      <div className="relative">

        {/* Frozen tooltip — pinned top-left as a plain div, completely outside Recharts */}
        {frozenTooltip && (
          <div className="absolute top-1 left-1 z-10 rounded-lg border bg-background p-2 text-xs shadow-md min-w-[120px] pointer-events-none">
            <p className="font-semibold mb-1 text-foreground">{frozenTooltip.matchLabel}</p>
            {frozenTooltip.entries.slice(0, TOOLTIP_MAX).map(entry => {
              const u = data.users.find(u => u.userId === entry.userId);
              return (
                <div key={entry.userId} className="flex items-center gap-1.5 py-0.5">
                  <span style={{ color: entry.stroke }}>■</span>
                  <span className="text-muted-foreground flex-1">{u?.username ?? entry.userId}</span>
                  <span className="font-bold text-foreground">{entry.value}</span>
                </div>
              );
            })}
            {frozenTooltip.entries.length > TOOLTIP_MAX && (
              <div className="text-muted-foreground py-0.5 pl-4">...</div>
            )}
          </div>
        )}

        {/* Zoom buttons — top right */}
        <div className="absolute top-1 right-1 z-10 flex gap-1">
          <button
            onClick={zoomIn}
            disabled={!canZoomIn}
            className="p-1.5 rounded-md bg-background/80 border shadow-sm hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="Zoom in (5 fewer rounds)"
          >
            <ZoomIn size={16} />
          </button>
          <button
            onClick={zoomOut}
            disabled={!canZoomOut}
            className="p-1.5 rounded-md bg-background/80 border shadow-sm hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="Zoom out (5 more rounds)"
          >
            <ZoomOut size={16} />
          </button>
        </div>

        <ResponsiveContainer width="100%" height={isMobile ? 420 : 280}>
          <LineChart
            data={displayData}
            margin={{ top: 5, right: ICON_R + 12, bottom: 5, left: -10 }}
            onClick={handleChartClick}
            onMouseMove={() => setSuppressTooltip(false)}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} />
            <XAxis
              dataKey="matchIndex"
              tick={{ fontSize: 10 }}
              tickLine={false}
              allowDecimals={false}
              tickFormatter={(v) => v === matchCount + 1 ? '' : String(v)}
            />
            <YAxis
              domain={[yDomainMin, (dataMax: number) => Math.ceil(dataMax + Math.max(dataMax * 0.1, 5))]}
              tick={{ fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              width={32}
            />
            {/*
              wrapperStyle hides Recharts' own tooltip wrapper when frozen so it cannot
              drift to the active point and fight with our pinned absolute div above.
            */}
            <Tooltip
              content={renderTooltip}
              wrapperStyle={frozenTooltip ? { display: 'none' } : undefined}
            />
            {data.users.map((u, i) => {
              const color = COLORS[i % COLORS.length];
              return (
                <Line
                  key={u.userId}
                  type="monotone"
                  dataKey={u.userId}
                  stroke={color}
                  strokeWidth={2}
                  isAnimationActive={false}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  dot={(props: any) => {
                    const { cx, cy, index } = props as { cx?: number; cy?: number; index?: number };
                    if (index !== sentinelIndex || cx == null || cy == null) return <g />;
                    if (u.imageUrl) {
                      const clipId = `uclip-${u.userId}`;
                      return (
                        <g key={`icon-${u.userId}`}>
                          <defs>
                            <clipPath id={clipId}>
                              <circle cx={cx} cy={cy} r={ICON_R} />
                            </clipPath>
                          </defs>
                          <circle cx={cx} cy={cy} r={ICON_R + 1} fill={color} />
                          <image
                            href={u.imageUrl}
                            x={cx - ICON_R}
                            y={cy - ICON_R}
                            width={ICON_R * 2}
                            height={ICON_R * 2}
                            clipPath={`url(#${clipId})`}
                          />
                        </g>
                      );
                    }
                    return (
                      <g key={`icon-${u.userId}`}>
                        <circle cx={cx} cy={cy} r={ICON_R} fill={color} />
                        <text
                          x={cx}
                          y={cy}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize={8}
                          fill="white"
                          fontWeight="bold"
                        >
                          {u.username.charAt(0).toUpperCase()}
                        </text>
                      </g>
                    );
                  }}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  activeDot={(props: any) => {
                    const { cx, cy, index, fill } = props as { cx?: number; cy?: number; index?: number; fill?: string };
                    if (index === sentinelIndex || cx == null || cy == null) return <g />;
                    return <circle key={`active-${u.userId}-${index}`} cx={cx} cy={cy} r={4} fill={fill ?? color} stroke="none" />;
                  }}
                  hide={hiddenUsers.has(u.userId)}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-2 mt-3 text-xs items-center">
        {data.users.map((u, i) => {
          const color = COLORS[i % COLORS.length];
          const isHidden = hiddenUsers.has(u.userId);
          return (
            <label key={u.userId} className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={!isHidden}
                onChange={() => toggleUser(u.userId)}
                style={{ accentColor: color }}
              />
              <span
                style={{ color: isHidden ? undefined : color }}
                className={isHidden ? 'text-muted-foreground' : 'font-medium'}
              >
                {u.username}
              </span>
            </label>
          );
        })}
        <label className="flex items-center gap-1.5 cursor-pointer select-none text-muted-foreground ml-auto">
          <input
            type="checkbox"
            checked={hiddenUsers.size === 0}
            onChange={toggleAll}
          />
          {t('competitionDetail.pointProgression.toggleAll')}
        </label>
      </div>
    </div>
  );
}
