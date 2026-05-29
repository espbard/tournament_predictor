import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import ImageUpload from '@/components/ImageUpload';
import type { Tournament } from '@tournament-predictor/shared';

export default function EditTournamentPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: tournament, isLoading } = useQuery({
    queryKey: ['tournament', id],
    queryFn: () => api.get<Tournament>(`/tournaments/${id}`),
    enabled: !!id,
  });

  const [name, setName] = useState('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [initialized, setInitialized] = useState(false);

  if (tournament && !initialized) {
    setName(tournament.name);
    setImageUrl(tournament.imageUrl ?? null);
    setInitialized(true);
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      api.patch<Tournament>(`/tournaments/${id}`, {
        name: name.trim(),
        imageUrl,
      }),
    onSuccess: updated => {
      queryClient.setQueryData(['tournament', id], updated);
      queryClient.invalidateQueries({ queryKey: ['tournaments'] });
      navigate(`/admin/tournaments/${id}`);
    },
    onError: (err: any) => setError(err instanceof ApiError ? err.message : 'Failed to save'),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    saveMutation.mutate();
  }

  if (isLoading) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  if (!tournament) return <div className="p-8 text-sm">Tournament not found.</div>;

  return (
    <main className="mx-auto max-w-sm px-4 py-8">
      <Link
        to={`/admin/tournaments/${id}`}
        className="mb-4 inline-block text-sm text-muted-foreground hover:text-foreground"
      >
        ← Back to tournament
      </Link>
      <h1 className="mb-6 text-2xl font-bold">Edit tournament</h1>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="name">
            Name
          </label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            required
            maxLength={100}
          />
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">Logo</p>
          <ImageUpload
            type="tournaments"
            currentUrl={imageUrl}
            onUploaded={setImageUrl}
            label="Change logo"
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={saveMutation.isPending || !name.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saveMutation.isPending ? 'Saving…' : 'Save changes'}
          </button>
          <Link
            to={`/admin/tournaments/${id}`}
            className="rounded-md border px-4 py-2 text-sm hover:bg-gray-50"
          >
            Cancel
          </Link>
        </div>
      </form>
    </main>
  );
}
