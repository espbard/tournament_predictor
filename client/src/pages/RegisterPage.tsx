import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import ImageUpload from '@/components/ImageUpload';
import { useT } from '@/lib/useT';
import type { User } from '@tournament-predictor/shared';

type AccountType = 'predictor' | 'leaderboard' | 'lateAddition';

export default function RegisterPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [accountType, setAccountType] = useState<AccountType>('predictor');
  const [showLeaderboardConfirm, setShowLeaderboardConfirm] = useState(false);
  const [showLateAdditionConfirm, setShowLateAdditionConfirm] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const { setUser } = useAuthStore();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { t } = useT();

  const isLeaderboardUser = accountType === 'leaderboard';
  const isLateAddition = accountType === 'lateAddition';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const user = await api.post<User>('/auth/register', {
        username,
        password,
        imageUrl,
        isLeaderboardUser,
        isLateAddition,
      });
      setUser(user);
      queryClient.setQueryData(['me'], user);
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('auth.registrationFailed'));
    } finally {
      setLoading(false);
    }
  }

  function handleLeaderboardConfirm() {
    setAccountType('leaderboard');
    setShowLeaderboardConfirm(false);
  }

  function handleLeaderboardCancel() {
    setShowLeaderboardConfirm(false);
  }

  function handleLateAdditionConfirm() {
    setAccountType('lateAddition');
    setShowLateAdditionConfirm(false);
  }

  function handleLateAdditionCancel() {
    setShowLateAdditionConfirm(false);
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center">
      {/* Leaderboard type confirmation dialog */}
      {showLeaderboardConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="w-full max-w-sm rounded-lg border bg-card p-6 shadow-lg space-y-4">
            <h2 className="text-lg font-semibold">Leaderboard Viewer account?</h2>
            <p className="text-sm text-muted-foreground">
              A <span className="font-medium text-foreground">Leaderboard Viewer</span> account lets you watch competitions without taking part:
            </p>
            <ul className="text-sm text-muted-foreground space-y-1 list-disc pl-4">
              <li>Enter an invite code to gain access to a competition's leaderboard</li>
              <li>View live standings at any time</li>
              <li>You will <span className="font-medium text-foreground">not</span> make predictions</li>
              <li>You will <span className="font-medium text-foreground">not</span> appear on the leaderboard yourself</li>
            </ul>
            <p className="text-sm text-muted-foreground">
              If you want to compete and make predictions, choose <span className="font-medium text-foreground">Predictor</span> instead.
            </p>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={handleLeaderboardConfirm}
                className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Yes, Leaderboard Viewer
              </button>
              <button
                type="button"
                onClick={handleLeaderboardCancel}
                className="flex-1 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                Back to Predictor
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Late Addition type confirmation dialog */}
      {showLateAdditionConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="w-full max-w-sm rounded-lg border bg-card p-6 shadow-lg space-y-4">
            <h2 className="text-lg font-semibold">Late Addition account?</h2>
            <p className="text-sm text-muted-foreground">
              A <span className="font-medium text-foreground">Late Addition</span> account lets you join competitions that are already underway:
            </p>
            <ul className="text-sm text-muted-foreground space-y-1 list-disc pl-4">
              <li>Join active competitions even after the prediction deadline</li>
              <li>Start with the same points as the current last-place player</li>
              <li>Get 24 hours to register your predictions after joining</li>
              <li>You can only predict on matches that haven't been played yet</li>
              <li>Missing group match predictions use the lowest-scorer's picks for standings</li>
            </ul>
            <p className="text-sm text-muted-foreground">
              If you want to join before the deadline, choose <span className="font-medium text-foreground">Predictor</span> instead.
            </p>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={handleLateAdditionConfirm}
                className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Yes, Late Addition
              </button>
              <button
                type="button"
                onClick={handleLateAdditionCancel}
                className="flex-1 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                Back to Predictor
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="w-full max-w-sm space-y-6 rounded-lg border bg-card p-8 shadow-sm">
        <h1 className="text-2xl font-bold">{t('auth.createAccount')}</h1>

        <div className="grid grid-cols-3 gap-2 rounded-md border p-1">
          <button
            type="button"
            onClick={() => setAccountType('predictor')}
            className={`rounded-sm px-3 py-2 text-sm font-medium transition-colors ${
              accountType === 'predictor'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Predictor
          </button>
          <button
            type="button"
            onClick={() => setShowLateAdditionConfirm(true)}
            className={`rounded-sm px-3 py-2 text-sm font-medium transition-colors ${
              accountType === 'lateAddition'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Late Addition
          </button>
          <button
            type="button"
            onClick={() => setShowLeaderboardConfirm(true)}
            className={`rounded-sm px-3 py-2 text-sm font-medium transition-colors ${
              accountType === 'leaderboard'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Leaderboard Viewer
          </button>
        </div>
        <p className="text-xs text-muted-foreground -mt-3">
          {accountType === 'leaderboard'
            ? 'View leaderboards only — no predictions, not on the scoreboard.'
            : accountType === 'lateAddition'
              ? 'Join competitions already in progress — starts at last place, 24h to predict on remaining matches.'
              : 'Make predictions and compete on the leaderboard.'}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="username">
              {t('auth.username')}
            </label>
            <input
              id="username"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="username"
            />
            <p className="text-xs text-muted-foreground">{t('auth.usernameHint')}</p>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="password">
              {t('auth.password')}
            </label>
            <input
              id="password"
              type="password"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
            <p className="text-xs text-muted-foreground">{t('auth.passwordHint')}</p>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">{t('auth.profilePicture')}</label>
            <ImageUpload
              type="users"
              currentUrl={imageUrl}
              onUploaded={setImageUrl}
              shape="circle"
              label="Choose photo"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? t('auth.creatingAccount') : t('auth.createAccount')}
          </button>
        </form>
        <p className="text-center text-sm text-muted-foreground">
          {t('auth.alreadyHaveAccount')}{' '}
          <Link to="/login" className="font-medium text-primary hover:underline">
            {t('auth.signInLink')}
          </Link>
        </p>
      </div>
    </main>
  );
}
