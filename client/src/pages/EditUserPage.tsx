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

      <EmailSection />
    </main>
  );
}

/**
 * The email a password reset goes to. Saved separately from the rest of the profile because
 * it asks for the current password: whoever holds a signed-in browser should not be able to
 * point the reset link at themselves.
 */
function EmailSection() {
  const { user, setUser } = useAuthStore();
  const queryClient = useQueryClient();
  const { t } = useT();

  const [email, setEmail] = useState(user?.email ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const current = user?.email ?? '';
  const changed = email.trim().toLowerCase() !== current;

  async function save(next: string | null) {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const updated = await api.patch<User>('/auth/me/email', { email: next, currentPassword });
      setUser(updated);
      queryClient.setQueryData(['me'], updated);
      setEmail(updated.email ?? '');
      setCurrentPassword('');
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.failedToSave'));
    } finally {
      setSaving(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    save(email.trim() || null);
  }

  return (
    <form onSubmit={handleSubmit} className="mt-10 space-y-4 border-t pt-6">
      <div>
        <h2 className="text-lg font-semibold">{t('editUser.email')}</h2>
        <p className="text-xs text-muted-foreground">{t('editUser.emailHint')}</p>
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium" htmlFor="email">
          {t('auth.email')}
        </label>
        <input
          id="email"
          type="email"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          value={email}
          onChange={(e) => { setEmail(e.target.value); setSaved(false); }}
          autoComplete="email"
        />
      </div>
      {(changed || current) && (
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="currentPassword">
            {t('editUser.currentPassword')}
          </label>
          <input
            id="currentPassword"
            type="password"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
          />
          <p className="text-xs text-muted-foreground">{t('editUser.currentPasswordHint')}</p>
        </div>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {saved && <p className="text-sm text-green-600">{t('common.saved')}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving || !changed || !currentPassword}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? t('common.saving') : t('editUser.saveEmail')}
        </button>
        {current && (
          <button
            type="button"
            disabled={saving || !currentPassword}
            onClick={() => save(null)}
            className="rounded-md border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
          >
            {t('editUser.removeEmail')}
          </button>
        )}
      </div>
    </form>
  );
}
