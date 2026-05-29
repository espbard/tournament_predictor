import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import ImageUpload from '@/components/ImageUpload';
import type { Competition, Tournament } from '@tournament-predictor/shared';

interface Member {
  id: string;
  username: string;
  imageUrl?: string | null;
  joinedAt: string;
}

export default function CompetitionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [editName, setEditName] = useState('');
  const [editImageUrl, setEditImageUrl] = useState<string | null>(null);
  const [editDeadline, setEditDeadline] = useState('');
  const [showEdit, setShowEdit] = useState(false);
  const [editError, setEditError] = useState('');

  const { data: competition, isLoading, error } = useQuery({
    queryKey: ['competitions', id],
    queryFn: () => api.get<Competition>(`/competitions/${id}`),
  });

  const { data: members = [] } = useQuery({
    queryKey: ['competitions', id, 'members'],
    queryFn: () => api.get<Member[]>(`/competitions/${id}/members`),
    enabled: !!competition,
  });

  const { data: tournaments = [] } = useQuery({
    queryKey: ['tournaments'],
    queryFn: () => api.get<Tournament[]>('/tournaments'),
    enabled: !!user?.isAdmin,
  });

  const updateMutation = useMutation({
    mutationFn: (body: { name?: string; imageUrl?: string | null; predictionDeadline?: string | null }) =>
      api.patch<Competition>(`/competitions/${id}`, body),
    onSuccess: () => {
      setShowEdit(false);
      setEditError('');
      queryClient.invalidateQueries({ queryKey: ['competitions', id] });
      queryClient.invalidateQueries({ queryKey: ['competitions'] });
    },
    onError: (err) => {
      setEditError(err instanceof ApiError ? err.message : 'Failed to update');
    },
  });

  function openEdit() {
    if (!competition) return;
    setEditName(competition.name);
    setEditImageUrl(competition.imageUrl ?? null);
    setEditDeadline(
      competition.predictionDeadline
        ? new Date(competition.predictionDeadline).toISOString().slice(0, 16)
        : ''
    );
    setShowEdit(true);
  }

  function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    updateMutation.mutate({
      name: editName.trim() || undefined,
      imageUrl: editImageUrl,
      predictionDeadline: editDeadline ? new Date(editDeadline).toISOString() : null,
    });
  }

  if (isLoading) return <p className="p-8 text-sm text-muted-foreground">Loading…</p>;
  if (error) {
    const msg = error instanceof ApiError ? error.message : 'Failed to load competition';
    return <p className="p-8 text-sm text-destructive">{msg}</p>;
  }
  if (!competition) return null;

  const tournament = tournaments.find(t => t.id === competition.tournamentId);

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <div className="mb-2 text-sm text-muted-foreground">
        <Link to={user?.isAdmin ? '/competitions' : '/'} className="hover:underline">
          ← {user?.isAdmin ? 'Competitions' : 'Home'}
        </Link>
      </div>

      <div className="mb-8 flex items-start gap-4">
        {competition.imageUrl ? (
          <img
            src={competition.imageUrl}
            alt={competition.name}
            className="h-16 w-16 rounded-lg object-cover flex-shrink-0"
          />
        ) : (
          <div className="h-16 w-16 rounded-lg bg-gray-100 flex-shrink-0" />
        )}
        <div className="flex-1">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold">{competition.name}</h1>
              {tournament && <p className="mt-1 text-sm text-muted-foreground">{tournament.name}</p>}
              {competition.predictionDeadline && (
                <p className="mt-1 text-sm text-muted-foreground">
                  Deadline: {new Date(competition.predictionDeadline).toLocaleString()}
                </p>
              )}
            </div>
            {user?.isAdmin && !showEdit && (
              <button
                onClick={openEdit}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-gray-50 flex-shrink-0"
              >
                Edit
              </button>
            )}
          </div>
        </div>
      </div>

      {user?.isAdmin && (
        <div className="mb-8 rounded-lg border bg-muted/30 p-4">
          <p className="text-sm font-medium">Invite Code</p>
          <p className="mt-1 font-mono text-3xl font-bold tracking-widest">{competition.inviteCode}</p>
          <p className="mt-1 text-xs text-muted-foreground">Share this code with players so they can join</p>
        </div>
      )}

      {showEdit && (
        <form onSubmit={handleUpdate} className="mb-8 rounded-lg border p-5 space-y-4">
          <h2 className="font-semibold">Edit Competition</h2>
          <div>
            <label className="mb-1 block text-sm font-medium">Name</label>
            <input
              type="text"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">
              Logo <span className="text-muted-foreground">(optional)</span>
            </label>
            <ImageUpload
              type="competitions"
              currentUrl={editImageUrl}
              onUploaded={setEditImageUrl}
              label="Change logo"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">
              Prediction Deadline <span className="text-muted-foreground">(optional)</span>
            </label>
            <input
              type="datetime-local"
              value={editDeadline}
              onChange={e => setEditDeadline(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          {editError && <p className="text-sm text-destructive">{editError}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={updateMutation.isPending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {updateMutation.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => { setShowEdit(false); setEditError(''); }}
              className="rounded-md border px-4 py-2 text-sm hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div>
        <h2 className="mb-4 font-semibold">Members ({members.length})</h2>
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">No members yet.</p>
        ) : (
          <div className="divide-y rounded-lg border">
            {members.map(m => (
              <div key={m.id} className="flex items-center gap-3 px-4 py-3">
                {m.imageUrl ? (
                  <img src={m.imageUrl} alt={m.username} className="h-8 w-8 rounded-full object-cover" />
                ) : (
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-sm font-semibold">
                    {m.username[0]?.toUpperCase()}
                  </span>
                )}
                <span className="text-sm font-medium">{m.username}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  Joined {new Date(m.joinedAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-8 rounded-lg border border-dashed p-8 text-center">
        <p className="text-sm text-muted-foreground">Predictions and leaderboard — coming soon</p>
      </div>
    </main>
  );
}
