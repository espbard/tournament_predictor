import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import ImageUpload from '@/components/ImageUpload';
import type { Competition, Tournament } from '@tournament-predictor/shared';

export default function CompetitionsPage() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [formError, setFormError] = useState('');
  const [name, setName] = useState('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [tournamentId, setTournamentId] = useState('');
  const [deadline, setDeadline] = useState('');

  const { data: competitions = [], isLoading } = useQuery({
    queryKey: ['competitions'],
    queryFn: () => api.get<Competition[]>('/competitions'),
  });

  const { data: tournaments = [] } = useQuery({
    queryKey: ['tournaments'],
    queryFn: () => api.get<Tournament[]>('/tournaments'),
  });

  const createMutation = useMutation({
    mutationFn: (body: {
      tournamentId: string;
      name: string;
      imageUrl?: string | null;
      predictionDeadline?: string | null;
    }) => api.post<Competition>('/competitions', body),
    onSuccess: () => {
      setShowForm(false);
      setName('');
      setImageUrl(null);
      setTournamentId('');
      setDeadline('');
      setFormError('');
      queryClient.invalidateQueries({ queryKey: ['competitions'] });
    },
    onError: (err) => {
      setFormError(err instanceof ApiError ? err.message : 'Failed to create competition');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/competitions/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['competitions'] }),
  });

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !tournamentId) {
      setFormError('Name and tournament are required');
      return;
    }
    createMutation.mutate({
      name: name.trim(),
      imageUrl,
      tournamentId,
      predictionDeadline: deadline ? new Date(deadline).toISOString() : null,
    });
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Competitions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Create competitions and share invite codes with players
          </p>
        </div>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            New Competition
          </button>
        )}
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="mb-8 rounded-lg border p-5 space-y-4">
          <h2 className="font-semibold">New Competition</h2>
          <div>
            <label className="mb-1 block text-sm font-medium">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. World Cup 2026 — Friends League"
              className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Tournament</label>
            <select
              value={tournamentId}
              onChange={e => setTournamentId(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Select a tournament…</option>
              {tournaments.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">
              Logo <span className="text-muted-foreground">(optional)</span>
            </label>
            <ImageUpload
              type="competitions"
              currentUrl={imageUrl}
              onUploaded={setImageUrl}
              label="Choose logo"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">
              Prediction Deadline <span className="text-muted-foreground">(optional)</span>
            </label>
            <input
              type="datetime-local"
              value={deadline}
              onChange={e => setDeadline(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          {formError && <p className="text-sm text-destructive">{formError}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {createMutation.isPending ? 'Creating…' : 'Create'}
            </button>
            <button
              type="button"
              onClick={() => { setShowForm(false); setFormError(''); setImageUrl(null); }}
              className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : competitions.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No competitions yet. Create one to get started.
        </p>
      ) : (
        <div className="grid gap-3">
          {competitions.map(c => {
            const tournament = tournaments.find(t => t.id === c.tournamentId);
            return (
              <div key={c.id} className="flex items-center gap-4 rounded-lg border p-4">
                {c.imageUrl ? (
                  <img src={c.imageUrl} alt={c.name} className="h-12 w-12 rounded-lg object-cover flex-shrink-0" />
                ) : (
                  <div className="h-12 w-12 rounded-lg bg-muted flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <Link to={`/competitions/${c.id}`} className="font-semibold hover:underline">
                    {c.name}
                  </Link>
                  {tournament && (
                    <p className="text-sm text-muted-foreground">{tournament.name}</p>
                  )}
                  <p className="mt-0.5 text-xs font-mono text-muted-foreground">
                    Invite: <span className="font-bold text-foreground">{c.inviteCode}</span>
                  </p>
                </div>
                <button
                  onClick={() => {
                    if (confirm(`Delete "${c.name}"?`)) deleteMutation.mutate(c.id);
                  }}
                  className="text-sm text-destructive hover:underline flex-shrink-0"
                >
                  Delete
                </button>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
