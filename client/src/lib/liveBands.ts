// ── Table band colours ────────────────────────────────────────────────────────
//
// A band is a run of table positions that means something in the competition — the
// Champions League league phase goes through on 1–8, into a play-off on 9–24 and out on
// 25 and below. See shared/src/live/formats.ts.
//
// The colours live here rather than in either component because the predicted table and
// the real one are read side by side: a green bar has to mean the same thing on both.
// A competition whose format defines no bands, or a band key these do not know, simply
// gets no colour rather than an arbitrary one.

/** The bar down the left of a row in that band's colour. */
export function bandBarClasses(bandKey: string | null): string {
  switch (bandKey) {
    case 'automatic':
      return 'border-l-4 border-l-green-500';
    case 'playoff':
      return 'border-l-4 border-l-amber-500';
    case 'eliminated':
      return 'border-l-4 border-l-muted-foreground/40';
    default:
      return '';
  }
}

/** The same colour as a small filled square, for the legend. */
export function bandSwatchClasses(bandKey: string): string {
  switch (bandKey) {
    case 'automatic':
      return 'bg-green-500';
    case 'playoff':
      return 'bg-amber-500';
    case 'eliminated':
      return 'bg-muted-foreground/40';
    default:
      return 'bg-transparent';
  }
}
