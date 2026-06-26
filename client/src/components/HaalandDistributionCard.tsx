import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, CartesianGrid } from 'recharts';
import { useThemeStore } from '@/store/themeStore';
import type { UserStatCardData } from '@tournament-predictor/shared';

const LIGHT_TITLE  = 'hsl(231, 70%, 28%)';
const LIGHT_BORDER = 'hsl(231, 70%, 28%)';
const LIGHT_TEXT   = 'hsl(180, 2%, 28%)';

const DARK_TITLE   = 'hsl(231, 60%, 65%)';
const DARK_BORDER  = 'hsl(231, 40%, 28%)';
const DARK_TEXT    = 'hsl(120, 3%, 85%)';

const BAR_COLOR = '#6366f1';
const ACTUAL_LINE_COLOR = '#eab308';

interface Props {
  data: UserStatCardData;
}

export default function HaalandDistributionCard({ data }: Props) {
  const isDark = useThemeStore((s) => s.theme === 'dark');
  const borderColor = isDark ? DARK_BORDER : LIGHT_BORDER;
  const titleColor  = isDark ? DARK_TITLE  : LIGHT_TITLE;
  const textColor   = isDark ? DARK_TEXT   : LIGHT_TEXT;
  const gridColor   = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';

  if (!data.distributionData?.length) return null;

  const renderTooltip = ({
    active,
    payload,
    label,
  }: {
    active?: boolean;
    payload?: Array<{ value?: number }>;
    label?: number;
  }) => {
    if (!active || !payload?.length) return null;
    const count = payload[0].value ?? 0;
    return (
      <div className="rounded-lg border bg-background p-2 text-xs shadow-md">
        <p className="font-semibold text-foreground">
          {label} goal{label === 1 ? '' : 's'}: {count} player{count === 1 ? '' : 's'}
        </p>
      </div>
    );
  };

  return (
    <div
      className="overflow-hidden rounded-2xl border-4 dark:border bg-[hsla(120,3%,91%,0.5)] dark:bg-[hsl(231,28%,16%)] px-4 pb-4 pt-3"
      style={{ borderColor }}
    >
      <h3
        className="text-xs font-bold uppercase tracking-wide text-center mb-3"
        style={{ color: titleColor }}
      >
        Haaland&apos;s predicted goals
      </h3>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart
          data={data.distributionData}
          margin={{ top: 4, right: 16, bottom: 4, left: -10 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
          <XAxis
            dataKey="value"
            tick={{ fontSize: 10, fill: textColor }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            tick={{ fontSize: 10, fill: textColor }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            width={24}
          />
          <Tooltip
            content={renderTooltip}
            cursor={{ fill: 'rgba(99,102,241,0.12)' }}
          />
          <Bar dataKey="count" fill={BAR_COLOR} radius={[3, 3, 0, 0]} maxBarSize={48} />
          {data.distributionActualValue != null && (
            <ReferenceLine
              x={data.distributionActualValue}
              stroke={ACTUAL_LINE_COLOR}
              strokeDasharray="5 3"
              strokeWidth={2}
            />
          )}
        </BarChart>
      </ResponsiveContainer>
      {data.distributionActualValue != null && (
        <p className="text-xs text-center mt-1" style={{ color: textColor }}>
          <span style={{ color: ACTUAL_LINE_COLOR, letterSpacing: '0.15em' }}>┅</span>
          {' '}Haaland has scored {data.distributionActualValue} goal{data.distributionActualValue === 1 ? '' : 's'} so far
        </p>
      )}
    </div>
  );
}
