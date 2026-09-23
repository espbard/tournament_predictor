import { Globe } from 'lucide-react';
import { useT } from '@/lib/useT';

// Public competitions, for both tournament types: readable by everyone signed in, playable
// by members only. These are the three pieces of UI the flag needs — the admin checkbox,
// the badge on a card, and the banner a non-member sees inside one.

/** The admin's "Public" checkbox, on the create and edit forms. */
export function PublicToggle({
  id,
  checked,
  onChange,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useT();
  return (
    <div>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={e => onChange(e.target.checked)}
          className="h-4 w-4 rounded border"
        />
        <label htmlFor={id} className="text-sm font-medium">
          {t('publicCompetition.label')}
        </label>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t('publicCompetition.hint')}</p>
    </div>
  );
}

/** Small "Public" pill; `viewOnly` swaps the wording for a card the caller has not joined. */
export function PublicBadge({ viewOnly = false, className = '' }: { viewOnly?: boolean; className?: string }) {
  const { t } = useT();
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground ${className}`}
    >
      <Globe size={11} aria-hidden />
      {viewOnly ? t('publicCompetition.viewOnly') : t('publicCompetition.badge')}
    </span>
  );
}

/** Shown to a non-member inside a public competition. */
export function ViewOnlyBanner({ className = '' }: { className?: string }) {
  const { t } = useT();
  return (
    <div
      className={`flex items-start gap-2 rounded-lg border bg-muted/30 px-4 py-2.5 text-sm text-muted-foreground ${className}`}
    >
      <Globe size={16} className="mt-0.5 flex-shrink-0" aria-hidden />
      <span>{t('publicCompetition.viewOnlyBanner')}</span>
    </div>
  );
}
