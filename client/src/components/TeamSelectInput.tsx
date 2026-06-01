import { useState, useEffect, useRef } from 'react';
import type { Team } from '@tournament-predictor/shared';

interface Props {
  value: string;       // team name
  onChange: (name: string) => void;
  teams: Team[];
  disabled?: boolean;
}

export default function TeamSelectInput({ value, onChange, teams, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const selectedTeam = teams.find(t => t.name === value) ?? null;

  const filtered = query.trim()
    ? teams.filter(t => t.name.toLowerCase().includes(query.toLowerCase()))
    : teams;

  function select(team: Team) {
    onChange(team.name);
    setOpen(false);
    setQuery('');
  }

  function clear() {
    onChange('');
  }

  if (disabled) {
    return (
      <div className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2">
        {selectedTeam?.imageUrl && (
          <img src={selectedTeam.imageUrl} alt="" className="h-5 w-5 rounded-full object-cover flex-shrink-0" />
        )}
        <span className="text-sm text-muted-foreground">{value || '—'}</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      {/* Selected team display */}
      {selectedTeam && !open ? (
        <div className="flex items-center gap-3 rounded-md border px-3 py-2 bg-muted/30 cursor-pointer" onClick={() => setOpen(true)}>
          {selectedTeam.imageUrl ? (
            <img src={selectedTeam.imageUrl} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0" />
          ) : (
            <div className="h-7 w-7 rounded-full bg-muted flex-shrink-0" />
          )}
          <span className="flex-1 text-sm font-medium truncate">{selectedTeam.name}</span>
          <button
            type="button"
            onClick={e => { e.stopPropagation(); clear(); }}
            className="text-muted-foreground hover:text-foreground text-sm flex-shrink-0"
          >
            ✕
          </button>
        </div>
      ) : (
        /* Search / open trigger */
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder={value || 'Select a team…'}
          className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      )}

      {/* Dropdown */}
      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-md border bg-background shadow-lg max-h-64 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">No teams found</p>
          ) : (
            filtered.map(team => (
              <button
                key={team.id}
                type="button"
                onMouseDown={e => e.preventDefault()}
                onClick={() => select(team)}
                className={`flex w-full items-center gap-3 px-3 py-2.5 hover:bg-muted text-left ${
                  team.name === value ? 'bg-muted/50' : ''
                }`}
              >
                {team.imageUrl ? (
                  <img src={team.imageUrl} alt="" className="h-8 w-8 rounded-full object-cover flex-shrink-0" />
                ) : (
                  <div className="h-8 w-8 rounded-full bg-muted flex-shrink-0" />
                )}
                <span className="text-sm font-medium truncate">{team.name}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
