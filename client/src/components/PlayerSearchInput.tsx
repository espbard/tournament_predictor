import { useState, useEffect, useRef } from 'react';
import { useT } from '@/lib/useT';
import {
  searchPlayers,
  isAborted,
  PLAYER_SEARCH_MIN_LENGTH,
  type PlayerOption,
} from '@/lib/playerSearch';

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

const SEARCH_DEBOUNCE_MS = 350;

export default function PlayerSearchInput({
  value,
  onChange,
  disabled,
  placeholder,
  allowFreeText = false,
}: Props) {
  const { t } = useT();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlayerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  // Which suggestion the arrow keys are on. -1 while the typed text is still what is shown.
  const [highlight, setHighlight] = useState(-1);
  // The search is a request to third-party databases. "They are down" and "there is no such
  // player" look identical on screen otherwise, and only one of them is worth retrying.
  const [searchFailed, setSearchFailed] = useState(false);
  // Player data for the currently selected value (only populated when selected this session)
  const [selectedMeta, setSelectedMeta] = useState<PlayerOption | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  // Nothing in flight outlives the field.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Bring the field up the screen when suggestions appear. On a phone the list renders
  // below an input that is often already near the keyboard, and a suggestion nobody can see
  // is a suggestion nobody can pick — which now means no answer at all.
  useEffect(() => {
    if (!open) return;
    containerRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [open]);

  // Keep the arrow-key selection inside the visible part of a scrolling list.
  useEffect(() => {
    if (highlight < 0) return;
    const row = listRef.current?.children[highlight] as HTMLElement | undefined;
    row?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

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
    setHighlight(-1);
    // Clear selected meta if user types over it
    if (selectedMeta && q !== selectedMeta.name) setSelectedMeta(null);
    // The typed text is the answer until a suggestion replaces it.
    if (allowFreeText) onChange(q);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    setSearchFailed(false);
    if (q.trim().length < PLAYER_SEARCH_MIN_LENGTH) {
      setResults([]);
      setOpen(false);
      setLoading(false);
      return;
    }

    // Open on the first keystroke worth searching, so the list can say it is working
    // rather than appearing out of nowhere a moment later.
    setOpen(true);
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const players = await searchPlayers(q, controller.signal);
        if (controller.signal.aborted) return;
        setResults(players);
        setHighlight(-1);
      } catch (err) {
        if (isAborted(err) || controller.signal.aborted) return;
        setResults([]);
        setSearchFailed(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);
  }

  function selectPlayer(p: PlayerOption) {
    abortRef.current?.abort();
    setSelectedMeta(p);
    setQuery(p.name);
    onChange(p.name);
    setOpen(false);
    setResults([]);
    setHighlight(-1);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setOpen(false);
      setHighlight(-1);
      return;
    }
    if (e.key === 'Enter') {
      if (open && highlight >= 0 && results[highlight]) {
        e.preventDefault();
        selectPlayer(results[highlight]);
      }
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (results.length === 0) return;
    e.preventDefault();
    setOpen(true);
    setHighlight(prev => {
      const next = e.key === 'ArrowDown' ? prev + 1 : prev - 1;
      if (next < 0) return results.length - 1;
      if (next >= results.length) return 0;
      return next;
    });
  }

  function clear() {
    abortRef.current?.abort();
    setSelectedMeta(null);
    setQuery('');
    onChange('');
    setResults([]);
    setOpen(false);
    setHighlight(-1);
    setSearchFailed(false);
  }

  const thumbUrl = selectedMeta?.thumb ? selectedMeta.thumb : null;

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
  const needsPick =
    !allowFreeText && !isSelected && query.trim().length >= PLAYER_SEARCH_MIN_LENGTH && !loading;

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
            <p className="text-sm font-medium truncate">{selectedMeta?.name ?? value}</p>
            {selectedMeta?.team && (
              <p className="text-xs text-muted-foreground truncate">{selectedMeta.team}</p>
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
            onKeyDown={handleKeyDown}
            onFocus={() => (results.length > 0 || loading) && setOpen(true)}
            placeholder={placeholder ?? (value || 'Search for a player…')}
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
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

      {/* Dropdown. Tall enough for five suggestions, and scrolls past that: a list that
          shows one name at a time is a list nobody can compare. */}
      {open && !isSelected && (loading || results.length > 0) && (
        <div className="absolute z-20 mt-1 w-full rounded-md border bg-background shadow-lg">
          {loading && results.length === 0 ? (
            <p className="px-3 py-2.5 text-sm text-muted-foreground">
              {t('bonusQuestions.picker.searching')}
            </p>
          ) : (
            <div ref={listRef} role="listbox" className="max-h-[17.5rem] overflow-y-auto">
              {results.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  aria-selected={i === highlight}
                  onMouseDown={e => e.preventDefault()}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => selectPlayer(p)}
                  className={`flex w-full items-center gap-3 px-3 py-2 text-left ${
                    i === highlight ? 'bg-muted' : 'hover:bg-muted'
                  }`}
                >
                  {p.thumb ? (
                    <img
                      src={p.thumb}
                      alt=""
                      className="h-8 w-8 rounded-full object-cover flex-shrink-0 bg-muted"
                      onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  ) : (
                    <div className="h-8 w-8 rounded-full bg-muted flex-shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{p.name}</p>
                    {p.team && (
                      <p className="text-xs text-muted-foreground truncate">{p.team}</p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
