import { useState, useRef, useEffect, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { LeaderboardProgressionResponse } from '@tournament-predictor/shared';

const COLORS = [
  '#6366f1', '#f59e0b', '#10b981', '#ef4444', '#3b82f6',
  '#ec4899', '#14b8a6', '#f97316', '#8b5cf6', '#84cc16',
];

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

export default function LeaderboardLineGraph({ data }: Props) {
  const [hiddenUsers, setHiddenUsers] = useState<Set<string>>(new Set());
  const [frozenTooltip, setFrozenTooltip] = useState<FrozenTooltip | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const chartData = data.matches.map((m, i) => {
    const point: Record<string, string | number> = { matchIndex: i + 1, matchLabel: m.label };
    for (const u of data.users) {
      point[u.userId] = m.cumulativePoints[u.userId] ?? 0;
    }
    return point;
  });

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

  const handleChartClick = useCallback((state: { activePayload?: Array<{ dataKey?: unknown; value?: unknown; stroke?: unknown }>; activeLabel?: unknown } | null) => {
    if (!state?.activePayload?.length) {
      setFrozenTooltip(null);
      return;
    }
    const matchIndex = state.activeLabel as number;
    const matchLabel = (chartData[matchIndex - 1]?.matchLabel as string) ?? String(matchIndex);
    const entries: FrozenEntry[] = state.activePayload
      .filter(p => !hiddenUsers.has(p.dataKey as string))
      .map(p => ({
        userId: p.dataKey as string,
        value: typeof p.value === 'number' ? p.value : Number(p.value ?? 0),
        stroke: typeof p.stroke === 'string' ? p.stroke : '',
      }))
      .sort((a, b) => b.value - a.value);
    setFrozenTooltip({ matchLabel, entries });
  }, [chartData, hiddenUsers]);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFrozenTooltip(null);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('touchstart', handleOutsideClick);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('touchstart', handleOutsideClick);
    };
  }, []);

  const renderTooltip = ({ active, payload, label }: { active?: boolean; payload?: ReadonlyArray<{ dataKey?: unknown; value?: unknown; stroke?: unknown }>; label?: unknown }) => {
    if (frozenTooltip) {
      return (
        <div className="rounded-lg border bg-background p-2 text-xs shadow-md min-w-[120px]">
          <p className="font-semibold mb-1 text-foreground">{frozenTooltip.matchLabel}</p>
          {frozenTooltip.entries.map(entry => {
            const u = data.users.find(u => u.userId === entry.userId);
            return (
              <div key={entry.userId} className="flex items-center gap-1.5 py-0.5">
                <span style={{ color: entry.stroke }}>■</span>
                <span className="text-muted-foreground flex-1">{u?.username ?? entry.userId}</span>
                <span className="font-bold text-foreground">{entry.value}</span>
              </div>
            );
          })}
        </div>
      );
    }
    if (!active || !payload?.length) return null;
    const matchLabel = (chartData[(label as number) - 1]?.matchLabel as string) ?? String(label);
    const sorted = [...payload]
      .filter(p => !hiddenUsers.has(p.dataKey as string))
      .sort((a, b) => (b.value as number) - (a.value as number));
    return (
      <div className="rounded-lg border bg-background p-2 text-xs shadow-md min-w-[120px]">
        <p className="font-semibold mb-1 text-foreground">{matchLabel}</p>
        {sorted.map(p => {
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
      </div>
    );
  };

  return (
    <div ref={containerRef}>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart
          data={chartData}
          margin={{ top: 5, right: 10, bottom: 5, left: -10 }}
          onClick={handleChartClick}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} />
          <XAxis
            dataKey="matchIndex"
            tick={{ fontSize: 10 }}
            tickLine={false}
            allowDecimals={false}
          />
          <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={32} />
          <Tooltip
            content={renderTooltip}
            wrapperStyle={frozenTooltip ? { visibility: 'visible', pointerEvents: 'none' } : undefined}
          />
          {data.users.map((u, i) => (
            <Line
              key={u.userId}
              type="monotone"
              dataKey={u.userId}
              stroke={COLORS[i % COLORS.length]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              hide={hiddenUsers.has(u.userId)}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>

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
                className={isHidden ? 'text-muted-foreground line-through' : 'font-medium'}
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
          Toggle all
        </label>
      </div>
    </div>
  );
}
