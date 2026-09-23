import { Globe } from 'lucide-react';
import { useT } from '@/lib/useT';

// Public competitions, for both tournament types: readable by everyone signed in, playable
// by members only. These are the two pieces of UI the flag needs — the admin checkbox and
// the badge on a card.

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
