import { AreaChart, Area, XAxis, YAxis, ResponsiveContainer, ReferenceLine, CartesianGrid } from 'recharts';
import { useThemeStore } from '@/store/themeStore';
import { useT } from '@/lib/useT';
import type { UserStatCardData } from '@tournament-predictor/shared';

const LIGHT_TITLE  = 'hsl(231, 70%, 28%)';
const LIGHT_BORDER = 'hsl(231, 70%, 28%)';
const LIGHT_TEXT   = 'hsl(180, 2%, 28%)';

const DARK_TITLE   = 'hsl(231, 60%, 65%)';
const DARK_BORDER  = 'hsl(231, 40%, 28%)';
const DARK_TEXT    = 'hsl(120, 3%, 85%)';

const LINE_COLOR = '#6366f1';
const ACTUAL_LINE_COLOR = '#eab308';

interface Props {
  data: UserStatCardData;
}

export default function HaalandDistributionCard({ data }: Props) {
  const isDark = useThemeStore((s) => s.theme === 'dark');
  const { language } = useT();
  const borderColor = isDark ? DARK_BORDER : LIGHT_BORDER;
  const titleColor  = isDark ? DARK_TITLE  : LIGHT_TITLE;
  const textColor   = isDark ? DARK_TEXT   : LIGHT_TEXT;
  const gridColor   = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';

  if (!data.distributionData?.length) return null;

  const heading =
    language === 'no' ? 'Haalands tippede mål' :
    language === 'de' ? 'Haalands getippte Tore' :
    "Haaland's predicted goals";

  const actualGoalsLabel = (n: number) =>
    language === 'no' ? `Haaland har scoret ${n} mål så langt` :
    language === 'de' ? `Haaland hat bisher ${n} Tor${n === 1 ? '' : 'e'} erzielt` :
    `Haaland has scored ${n} goal${n === 1 ? '' : 's'} so far`;

  return (
    <div
      className="overflow-hidden rounded-2xl border-4 dark:border bg-[hsla(120,3%,91%,0.5)] dark:bg-[hsl(231,28%,16%)] px-4 pb-4 pt-3"
      style={{ borderColor }}
    >
      <h3
        className="text-xs font-bold uppercase tracking-wide text-center mb-3"
        style={{ color: titleColor }}
      >
        {heading}
      </h3>
      <ResponsiveContainer width="100%" height={160}>
        <AreaChart
          data={data.distributionData}
          margin={{ top: 4, right: 16, bottom: 4, left: -10 }}
        >
          <defs>
            <linearGradient id="distFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={LINE_COLOR} stopOpacity={0.3} />
              <stop offset="95%" stopColor={LINE_COLOR} stopOpacity={0.03} />
            </linearGradient>
          </defs>
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
          <Area
            type="monotone"
            dataKey="count"
            stroke={LINE_COLOR}
            strokeWidth={2}
            fill="url(#distFill)"
            dot={false}
            isAnimationActive={false}
          />
          {data.distributionActualValue != null && (
            <ReferenceLine
              x={data.distributionActualValue}
              stroke={ACTUAL_LINE_COLOR}
              strokeDasharray="5 3"
              strokeWidth={2}
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
      {data.distributionActualValue != null && (
        <p className="text-xs text-center mt-1" style={{ color: textColor }}>
          <span style={{ color: ACTUAL_LINE_COLOR, letterSpacing: '0.15em' }}>┅</span>
          {' '}{actualGoalsLabel(data.distributionActualValue)}
        </p>
      )}
    </div>
  );
}
