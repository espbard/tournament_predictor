import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import BackButton from '@/components/BackButton';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import ImageUpload from '@/components/ImageUpload';
import { UserAvatar } from '@/components/UserAvatar';
import { useT } from '@/lib/useT';
import type { User } from '@tournament-predictor/shared';

export default function EditUserPage() {
  const { user, setUser } = useAuthStore();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { t } = useT();

  const [imageUrl, setImageUrl] = useState<string | null>(user?.imageUrl ?? null);
  const [iconColor, setIconColor] = useState<string>(user?.iconColor ?? '#4b5563');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const updated = await api.patch<User>('/auth/me', { imageUrl, iconColor });
      setUser(updated);
      queryClient.setQueryData(['me'], updated);
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.failedToSave'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto max-w-sm md:max-w-lg px-4 pt-2.5 pb-8 sm:pt-8">
      <BackButton href="/" />
      <h1 className="mb-6 text-2xl font-bold">{t('editUser.title')}</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <p className="mb-2 text-sm font-medium">{t('editUser.profilePicture')}</p>
          <ImageUpload
            type="users"
            currentUrl={imageUrl}
            onUploaded={setImageUrl}
            shape="circle"
            label={t('editUser.changePhoto')}
          />
        </div>

        {!imageUrl && (
          <div>
            <p className="mb-2 text-sm font-medium">{t('editUser.iconColor')}</p>
            <div className="flex items-center gap-3">
              <UserAvatar
                username={user?.username ?? '?'}
                imageUrl={null}
                iconColor={iconColor}
                className="h-12 w-12"
              />
              <input
                type="color"
                value={iconColor}
                onChange={e => setIconColor(e.target.value)}
                className="h-10 w-16 cursor-pointer rounded border p-0.5"
              />
            </div>
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? t('common.saving') : t('editUser.saveChanges')}
          </button>
          <Link
            to="/"
            className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
          >
            {t('common.cancel')}
          </Link>
        </div>
      </form>
    </main>
  );
}
