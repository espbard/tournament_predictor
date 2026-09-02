import type { UserStatCardData } from '@tournament-predictor/shared';

// ── A live competition's stat card ────────────────────────────────────────────
//
// The manual competition type's UserStatCard is a picture above a block of text, with an
// emoji stamped in the corner to say which card it is. This is the same payload rendered
// as a tile: the subject is the tile's background and the words sit on top of it, with no
// emoji — the crest already says what the card is about.
//
// The tile does not follow the theme, because the crests on it do not either. It runs
// light at the top and dark at the foot: a crest is drawn to sit on white, and plenty of
// them are near-black outlines that a dark tile swallows, while the words need a dark
// ground to be white on. One gradient gives both.

interface Props {
  data: UserStatCardData;
}

// Beyond four the crests are too small to recognise, and a tie that deep says nothing
// anyway — every name is still in the sentence.
const MAX_CRESTS = 4;

/** Renders the `**bold**` markers the server puts around team names and numbers. */
function renderStatistic(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={i} className="font-semibold text-amber-300">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
  );
}

export default function LiveUserStatCard({ data }: Props) {
  const subjects = data.subjects.slice(0, MAX_CRESTS);

  return (
    <article className="relative flex flex-col overflow-hidden rounded-2xl border border-border bg-gradient-to-b from-white via-slate-100 via-42% to-slate-950">
      {/* Every cell takes its width from the row and its height from that width, so the
          picture is square however many share the row and however narrow the tile is —
          setting a height instead leaves ovals once max-width starts clamping. The size
          therefore depends on the tie, not on whether the sentence runs to three lines. */}
      <div aria-hidden className="flex items-center justify-center gap-3 px-6 pt-5">
        {subjects.map(subject => (
          <span
            key={subject.id}
            className={`aspect-square min-w-0 max-w-[9rem] flex-1 ${
              // A crest is a logo on empty space, so it is shown whole. A player is a
              // photograph, cropped to a circle — the treatment they get in the ranking
              // they came from.
              subject.type === 'team'
                ? ''
                : 'overflow-hidden rounded-full shadow-[0_2px_10px_rgba(0,0,0,0.35)] ring-2 ring-white/70'
            }`}
          >
            <img
              src={subject.imageUrl ?? '/default-avatar.png'}
              alt=""
              className={`h-full w-full ${
                subject.type === 'team'
                  ? 'object-contain drop-shadow-[0_2px_6px_rgba(0,0,0,0.35)]'
                  : 'object-cover'
              }`}
            />
          </span>
        ))}
      </div>

      {/* Dark under the words, clear over the crests. Painted after them, so it dims the
          foot of a crest that hangs low rather than being covered by it. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black via-black/75 via-28% to-transparent"
      />

      <div className="relative px-4 pb-4 pt-3">
        <h3 className="text-center text-sm font-bold uppercase tracking-wide text-white">
          {data.title}
        </h3>
        <p className="mt-1.5 text-sm leading-snug text-white/85">
          {renderStatistic(data.statistic)}
        </p>
      </div>
    </article>
  );
}
