import { useState, useEffect, useRef } from 'react';
import { useT } from '@/lib/useT';

interface SportsDbPlayer {
  idPlayer: string;
  strPlayer: string;
  strTeam: string | null;
  strSport: string | null;
  strThumb: string | null;
  strCutout: string | null;
}

interface Props {
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /**
   * Take a typed name as the value, without waiting for a pick from the suggestions.
   *
   * For the admin side only — setting a question's correct answer, or building its list of
   * allowed ones, where the name wanted may be one the external database does not carry.
   *
   * Never for answering a question. An answer is graded by comparing text, so a typo or a
   * different spelling of the same player silently scores nothing; picking from the list is
   * what keeps everyone's answer to one question spelled the same way.
   */
  allowFreeText?: boolean;
}

export default function PlayerSearchInput({
  value,
  onChange,
  disabled,
  placeholder,
  allowFreeText = false,
}: Props) {
  const { t } = useT();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SportsDbPlayer[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  // The search is a request to a third-party database. "It is down" and "there is no such
  // player" look identical on screen otherwise, and only one of them is worth retrying.
  const [searchFailed, setSearchFailed] = useState(false);
  // Player data for the currently selected value (only populated when selected this session)
  const [selectedMeta, setSelectedMeta] = useState<SportsDbPlayer | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  // Bring the field up the screen when suggestions appear. On a phone the list renders
  // below an input that is often already near the keyboard, and a suggestion nobody can see
  // is a suggestion nobody can pick — which now means no answer at all.
  useEffect(() => {
    if (!open) return;
    containerRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [open]);

  // When value is cleared externally, reset
  useEffect(() => {
    if (!value) {
      setQuery('');
      setSelectedMeta(null);
      setSearchFailed(false);
    }
  }, [value]);

  function handleInputChange(q: string) {
    setQuery(q);
    // Clear selected meta if user types over it
    if (selectedMeta && q !== selectedMeta.strPlayer) setSelectedMeta(null);
    // The typed text is the answer until a suggestion replaces it.
    if (allowFreeText) onChange(q);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearchFailed(false);
    if (q.trim().length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `https://www.thesportsdb.com/api/v1/json/3/searchplayers.php?p=${encodeURIComponent(q.trim())}`
        );
        const data = await res.json();
        const players: SportsDbPlayer[] = (data.player ?? [])
          .filter((p: SportsDbPlayer) => !p.strSport || p.strSport === 'Soccer')
          .slice(0, 8);
        setResults(players);
        setOpen(players.length > 0);
      } catch {
        setResults([]);
        setOpen(false);
        setSearchFailed(true);
      } finally {
        setLoading(false);
      }
    }, 350);
  }

  function selectPlayer(p: SportsDbPlayer) {
    setSelectedMeta(p);
    setQuery(p.strPlayer);
    onChange(p.strPlayer);
    setOpen(false);
    setResults([]);
  }

  function clear() {
    setSelectedMeta(null);
    setQuery('');
    onChange('');
    setResults([]);
    setOpen(false);
    setSearchFailed(false);
  }

  const thumbUrl = selectedMeta?.strThumb && selectedMeta.strThumb !== ''
    ? selectedMeta.strThumb
    : null;

  // Disabled read-only display
  if (disabled) {
    return (
      <div className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2">
        <span className="text-sm text-muted-foreground">{value || '—'}</span>
      </div>
    );
  }

  // Show selected card whenever a value is present (either from this session or loaded from
  // saved answer). With free text the value changes on every keystroke, so the card is
  // shown only for a real pick — otherwise it would swallow the field mid-word.
  const isSelected = allowFreeText ? !!selectedMeta : !!value;

  // Where a pick is required, typed text is not an answer — say so once there is enough of
  // it to have searched on and the search has come back.
  const needsPick = !allowFreeText && !isSelected && query.trim().length >= 2 && !loading;

  return (
    <div ref={containerRef} className="relative">
      {/* Selected player card */}
      {isSelected ? (
        <div className="flex items-center gap-3 rounded-md border px-3 py-2 bg-muted/30">
          {thumbUrl ? (
            <img
              src={thumbUrl}
              alt=""
              className="h-10 w-10 rounded-full object-cover flex-shrink-0 bg-muted"
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          ) : (
            <div className="h-10 w-10 rounded-full bg-muted flex-shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{selectedMeta?.strPlayer ?? value}</p>
            {selectedMeta?.strTeam && (
              <p className="text-xs text-muted-foreground truncate">{selectedMeta.strTeam}</p>
            )}
          </div>
          <button
            type="button"
            onClick={clear}
            className="text-muted-foreground hover:text-foreground text-sm flex-shrink-0 ml-1"
          >
            ✕
          </button>
        </div>
      ) : (
        /* Search input */
        <div className="relative">
          <input
            type="text"
            value={query}
            onChange={e => handleInputChange(e.target.value)}
            onFocus={() => results.length > 0 && setOpen(true)}
            placeholder={placeholder ?? (value || 'Search for a player…')}
            className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {loading && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">…</span>
          )}
        </div>
      )}

      {/* Typed but not picked, so there is no answer yet. Said out loud rather than left to
          a disabled save button, since on a phone the suggestions can be under the keyboard. */}
      {needsPick && (
        <p
          className={`mt-1 text-xs ${searchFailed ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}
        >
          {searchFailed
            ? t('bonusQuestions.picker.searchUnavailable')
            : results.length === 0
              ? t('bonusQuestions.picker.noMatches')
              : t('bonusQuestions.picker.pickOne')}
        </p>
      )}

      {/* Dropdown */}
      {open && results.length > 0 && (
        <div className="absolute z-20 mt-1 w-full rounded-md border bg-background shadow-lg max-h-64 overflow-y-auto">
          {results.map(p => {
            const img = p.strThumb && p.strThumb !== '' ? p.strThumb : null;
            return (
              <button
                key={p.idPlayer}
                type="button"
                onMouseDown={e => e.preventDefault()}
                onClick={() => selectPlayer(p)}
                className="flex w-full items-center gap-3 px-3 py-2.5 hover:bg-muted text-left"
              >
                {img ? (
                  <img
                    src={img}
                    alt=""
                    className="h-9 w-9 rounded-full object-cover flex-shrink-0 bg-muted"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                ) : (
                  <div className="h-9 w-9 rounded-full bg-muted flex-shrink-0" />
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{p.strPlayer}</p>
                  {p.strTeam && (
                    <p className="text-xs text-muted-foreground truncate">{p.strTeam}</p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
