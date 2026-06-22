import { useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { LeaderboardProgressionResponse } from '@tournament-predictor/shared';

const COLORS = [
  '#6366f1', '#f59e0b', '#10b981', '#ef4444', '#3b82f6',
  '#ec4899', '#14b8a6', '#f97316', '#8b5cf6', '#84cc16',
];

interface Props {
  data: LeaderboardProgressionResponse;
}

export default function LeaderboardLineGraph({ data }: Props) {
  const [hiddenUsers, setHiddenUsers] = useState<Set<string>>(new Set());

  const chartData = data.matches.map(m => {
    const point: Record<string, string | number> = { label: m.label };
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

  return (
    <div>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={chartData} margin={{ top: 5, right: 10, bottom: 5, left: -10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 9 }}
            interval="preserveStartEnd"
            tickLine={false}
          />
          <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={32} />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const sorted = [...payload]
                .filter(p => !hiddenUsers.has(p.dataKey as string))
                .sort((a, b) => (a.value as number) - (b.value as number))
                .reverse();
              return (
                <div className="rounded-lg border bg-background p-2 text-xs shadow-md min-w-[120px]">
                  <p className="font-semibold mb-1 text-foreground">{label}</p>
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
            }}
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
