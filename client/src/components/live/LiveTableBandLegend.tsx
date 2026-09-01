import { useT } from '@/lib/useT';
import { bandSwatchClasses } from '@/lib/liveBands';
import type { LiveTableBand } from '@tournament-predictor/shared';

// ── What the coloured bars mean ───────────────────────────────────────────────
//
// Shown under both the real table and the predicted one. A bar down the side of a row is
// only readable with this next to it, so wherever one is drawn this goes too.

interface Props {
  bands: LiveTableBand[];
  className?: string;
}

export default function LiveTableBandLegend({ bands, className = '' }: Props) {
  const { t } = useT();
  if (bands.length === 0) return null;

  return (
    <ul className={`flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground ${className}`}>
      {bands.map(band => (
        <li key={band.key} className="flex items-center gap-1.5">
          <span className={`inline-block h-2.5 w-2.5 rounded-sm ${bandSwatchClasses(band.key)}`} />
          {t(band.labelKey)} ({band.from}
          {band.to === null ? '+' : `–${band.to}`})
        </li>
      ))}
    </ul>
  );
}
