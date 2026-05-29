import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import ImageUpload from '@/components/ImageUpload';
import type { User } from '@tournament-predictor/shared';

export default function EditUserPage() {
  const { user, setUser } = useAuthStore();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [imageUrl, setImageUrl] = useState<string | null>(user?.imageUrl ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const updated = await api.patch<User>('/auth/me', { imageUrl });
      setUser(updated);
      queryClient.setQueryData(['me'], updated);
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto max-w-sm px-4 py-8">
      <Link to="/" className="mb-4 inline-block text-sm text-muted-foreground hover:text-foreground">
        ← Back
      </Link>
      <h1 className="mb-6 text-2xl font-bold">Edit profile</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <p className="mb-2 text-sm font-medium">Profile picture</p>
          <ImageUpload
            type="users"
            currentUrl={imageUrl}
            onUploaded={setImageUrl}
            shape="circle"
            label="Change photo"
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <Link
            to="/"
            className="rounded-md border px-4 py-2 text-sm hover:bg-gray-50"
          >
            Cancel
          </Link>
        </div>
      </form>
    </main>
  );
}
