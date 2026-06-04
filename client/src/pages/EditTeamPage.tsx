import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import ImageUpload from '@/components/ImageUpload';
import { useT } from '@/lib/useT';
import type { Team, Group } from '@tournament-predictor/shared';

export default function EditTeamPage() {
  const { teamId } = useParams<{ teamId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useT();

  const { data: team, isLoading } = useQuery({
    queryKey: ['team', teamId],
    queryFn: () => api.get<Team>(`/teams/${teamId}`),
    enabled: !!teamId,
  });

  const { data: groupList = [] } = useQuery({
    queryKey: ['groups', team?.tournamentId],
    queryFn: () => api.get<Group[]>(`/tournaments/${team!.tournamentId}/groups`),
    enabled: !!team?.tournamentId,
  });

  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState<string>('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [initialized, setInitialized] = useState(false);

  if (team && !initialized) {
    setName(team.name);
    setGroupId(team.groupId ?? '');
    setImageUrl(team.imageUrl ?? null);
    setInitialized(true);
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      api.patch<Team>(`/teams/${teamId}`, {
        name: name.trim(),
        groupId: groupId || null,
        imageUrl,
      }),
    onSuccess: updated => {
      queryClient.setQueryData(['team', teamId], updated);
      queryClient.invalidateQueries({ queryKey: ['teams', updated.tournamentId] });
      navigate(`/admin/tournaments/${updated.tournamentId}`);
    },
    onError: (err: any) => setError(err instanceof ApiError ? err.message : t('common.failedToSave')),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    saveMutation.mutate();
  }

  if (isLoading) return <div className="p-8 text-sm text-muted-foreground">{t('common.loading')}</div>;
  if (!team) return <div className="p-8 text-sm">{t('editTeam.notFound')}</div>;

  return (
    <main className="mx-auto max-w-sm px-4 py-8">
      <Link
        to={`/admin/tournaments/${team.tournamentId}`}
        className="mb-4 inline-block text-sm text-muted-foreground hover:text-foreground"
      >
        {t('editTeam.backToTournament')}
      </Link>
      <h1 className="mb-6 text-2xl font-bold">{t('editTeam.title')}</h1>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="name">
            {t('common.name')}
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
          <label className="mb-1 block text-sm font-medium" htmlFor="group">
            {t('editTeam.group')}
          </label>
          <select
            id="group"
            value={groupId}
            onChange={e => setGroupId(e.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">{t('editTeam.uncategorized')}</option>
            {groupList.map(g => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">{t('editTeam.icon')}</p>
          <ImageUpload
            type="teams"
            currentUrl={imageUrl}
            onUploaded={setImageUrl}
            label={t('editTeam.changeIcon')}
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={saveMutation.isPending || !name.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saveMutation.isPending ? t('common.saving') : t('common.saveChanges')}
          </button>
          <Link
            to={`/admin/tournaments/${team.tournamentId}`}
            className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
          >
            {t('common.cancel')}
          </Link>
        </div>
      </form>
    </main>
  );
}
