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
      {/* A fixed height rather than the space left over, so the crests are the same size
          on a card whose sentence runs to three lines as on one that fits in two. */}
      <div aria-hidden className="flex h-36 items-center justify-center gap-3 px-6 pt-5">
        {subjects.map(subject => (
          <img
            key={subject.id}
            src={subject.imageUrl ?? '/default-avatar.png'}
            alt=""
            className="h-full min-w-0 flex-1 object-contain drop-shadow-[0_2px_6px_rgba(0,0,0,0.35)]"
          />
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
