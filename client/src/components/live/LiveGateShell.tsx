import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '@/lib/useT';

// ── The full-screen gate ──────────────────────────────────────────────────────
//
// The screen a member sees instead of a live competition until they have made the
// predictions that cannot be made later. Shared by the table-prediction gate and the
// bonus-question gate so the two steps of the flow look like one thing.
//
// Deliberately the whole viewport, over the app chrome: the point is that there is
// nothing else to look at yet. The one way out that is not the form is a link back to the
// competition list, so a user who opened the wrong league is not stuck in it.
//
// Rendered inside `.dark` whatever the user's theme, because the screen is a dark blue to
// black gradient and the cards on it have to sit on that rather than fight it.

interface Props {
  /** Small line above the title — the competition being joined. */
  eyebrow: string;
  title: string;
  subtitle?: string;
  /** Progress through a multi-step gate, e.g. "Question 2/5". */
  step?: string;
  children: ReactNode;
  /**
   * Pinned to the foot of the screen. The table gate leaves this empty and lets
   * LiveTablePrediction render its own bar, because only that component knows the order
   * being submitted.
   */
  footer?: ReactNode;
}

export default function LiveGateShell({
  eyebrow,
  title,
  subtitle,
  step,
  children,
  footer,
}: Props) {
  const { t } = useT();

  return (
    <div className="dark fixed inset-0 z-50 overflow-y-auto bg-gradient-to-b from-[#0b1f4b] via-[#050c1f] to-black text-foreground">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-4 pb-6 pt-8 sm:pt-12">
        <header className="mb-6">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-xs font-medium uppercase tracking-wider text-white/50">{eyebrow}</p>
            {step && <p className="text-xs font-medium tabular-nums text-white/50">{step}</p>}
          </div>
          <h1 className="mt-2 text-2xl font-bold text-white sm:text-3xl">{title}</h1>
          {subtitle && <p className="mt-2 text-sm text-white/70">{subtitle}</p>}
        </header>

        <div className="flex-1">{children}</div>

        {footer && (
          <div className="sticky bottom-0 z-10 -mx-4 mt-4 border-t border-white/10 bg-black/70 px-4 py-3 backdrop-blur">
            {footer}
          </div>
        )}

        <div className="mt-4 text-center">
          <Link to="/" className="text-xs text-white/50 underline-offset-4 hover:underline">
            {t('live.table.gateLeave')}
          </Link>
        </div>
      </div>
    </div>
  );
}
