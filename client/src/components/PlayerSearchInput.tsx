import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '@/lib/useT';
import {
  searchPlayers,
  narrowCachedPlayers,
  filterPlayersByQuery,
  warmPlayerSearch,
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

/**
 * Long enough that a fast typist is one search rather than eight, short enough that a
 * thoughtful one is not left waiting on a timer before the request even goes out. Anything
 * already searched is answered from the cache without waiting for this at all.
 */
const SEARCH_DEBOUNCE_MS = 180;

/** Room for five suggestions. Past that the panel scrolls rather than grows. */
const PANEL_MAX_HEIGHT = 320;

/** Breathing room between the panel and the edge of the window. */
const VIEWPORT_MARGIN = 12;

interface PanelPosition {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
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
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /**
   * Where the suggestions go.
   *
   * Measured off the field and drawn at the top of the document rather than beside it: the
   * panel then belongs to no card and no scrolling box, so nothing can clip it and nothing
   * moves to make room for it. The field's own section keeps exactly the height it had
   * before anybody typed.
   */
  const updatePosition = useCallback(() => {
    const anchor = containerRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
    const above = rect.top - VIEWPORT_MARGIN;
    // Above the field when there is more room there — which is what a field near the foot
    // of a phone screen, under the keyboard, always has.
    const flip = below < PANEL_MAX_HEIGHT && above > below;
    setPosition({
      left: rect.left,
      width: rect.width,
      top: flip ? undefined : rect.bottom + 4,
      bottom: flip ? window.innerHeight - rect.top + 4 : undefined,
      maxHeight: Math.min(PANEL_MAX_HEIGHT, Math.max(flip ? above : below, 120)),
    });
  }, []);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      // The panel lives outside this component's box now, so "outside" has to mean outside
      // both — otherwise the first click on a suggestion closes the list it is aimed at.
      if (containerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  // Nothing in flight outlives the field.
  useEffect(() => () => abortRef.current?.abort(), []);

  // A panel drawn at fixed coordinates has to be re-measured whenever anything moves it:
  // the page scrolling, a scrolling card, the window resizing, the phone turning.
  useEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [open, updatePosition]);

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

    // Answer this keystroke before anybody is asked anything. Typing a name is the same
    // search over and over, each one a longer version of the last, so a search already made
    // usually covers it — and failing that, the suggestions already on screen are narrowed
    // to the ones that still match. Either way the list never shows a name that no longer
    // fits what is in the field.
    setResults(prev => narrowCachedPlayers(q) ?? filterPlayersByQuery(prev, q));

    // Open on the first keystroke worth searching, so the panel can say it is working
    // rather than appearing out of nowhere a moment later.
    setOpen(true);
    updatePosition();
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const players = await searchPlayers(q, {
          signal: controller.signal,
          // Every time one of the databases reports, not once they all have.
          onResults: found => {
            if (controller.signal.aborted) return;
            setResults(found);
          },
        });
        // The last word: a search that found nothing has to be able to empty a list that
        // narrowing put there.
        if (!controller.signal.aborted) setResults(players);
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

  // Where a pick is required, typed text is not an answer. Said with the field's own border
  // rather than a line of text under it: a warning that comes and goes with the search would
  // otherwise push the rest of the question around while somebody is still typing.
  const needsPick =
    !allowFreeText && !isSelected && query.trim().length >= PLAYER_SEARCH_MIN_LENGTH && !loading;

  const message = searchFailed
    ? t('bonusQuestions.picker.searchUnavailable')
    : results.length === 0 && !loading
      ? t('bonusQuestions.picker.noMatches')
      : null;

  const showPanel = open && !isSelected && (loading || results.length > 0 || message !== null);

  // The border only warns once there is something to warn about: while the suggestions are
  // up, the panel's own footer says what to do, and a field somebody is still typing into
  // has no business looking like a mistake.
  const warn = needsPick && (!showPanel || results.length === 0);

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
            onFocus={() => {
              // Open the connections now, while somebody is still reaching for the first
              // letter: the first search is then a request rather than two handshakes.
              warmPlayerSearch();
              if (results.length === 0 && !loading && !searchFailed) return;
              setOpen(true);
              updatePosition();
            }}
            placeholder={placeholder ?? (value || 'Search for a player…')}
            role="combobox"
            aria-expanded={showPanel}
            aria-autocomplete="list"
            title={needsPick ? t('bonusQuestions.picker.pickOne') : undefined}
            className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 ${
              warn
                ? 'border-amber-500 focus:ring-amber-500 dark:border-amber-400'
                : 'focus:ring-ring'
            }`}
          />
          {loading && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">…</span>
          )}
        </div>
      )}

      {/* The suggestions, drawn over the page rather than inside the question. Five fit;
          the rest scroll. Nothing here takes up room in the layout underneath. */}
      {showPanel && position &&
        createPortal(
          <div
            ref={panelRef}
            role="listbox"
            style={{
              position: 'fixed',
              left: position.left,
              width: position.width,
              top: position.top,
              bottom: position.bottom,
              maxHeight: position.maxHeight,
            }}
            className="z-[60] flex flex-col overflow-hidden rounded-md border bg-background shadow-lg"
          >
            {loading && results.length === 0 ? (
              <p className="px-3 py-2.5 text-sm text-muted-foreground">
                {t('bonusQuestions.picker.searching')}
              </p>
            ) : results.length === 0 ? (
              <p
                className={`px-3 py-2.5 text-sm ${
                  searchFailed ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
                }`}
              >
                {message}
              </p>
            ) : (
              <>
                <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
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
                {/* Typed but not picked is not an answer, and the phone user who cannot see
                    a disabled save button below the keyboard is told so here. */}
                {!allowFreeText && (
                  <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">
                    {t('bonusQuestions.picker.pickOne')}
                  </p>
                )}
              </>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
