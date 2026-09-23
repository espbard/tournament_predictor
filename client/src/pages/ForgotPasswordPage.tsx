import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useT } from '@/lib/useT';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { t, language } = useT();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/forgot-password', { email, language });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('auth.forgot.failed'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6 rounded-lg border bg-card p-8 shadow-sm">
        <h1 className="text-2xl font-bold">{t('auth.forgot.title')}</h1>
        {sent ? (
          <div className="space-y-4">
            {/* Worded the same whether or not the address has an account, like the server's reply. */}
            <p className="text-sm text-muted-foreground">{t('auth.forgot.sent')}</p>
            {/* Sent from a free address through Brevo, the email often lands in spam — this
                must be impossible to miss. */}
            <div
              role="alert"
              className="flex gap-3 rounded-lg border-2 border-amber-500 bg-amber-100 p-4 text-amber-950 dark:border-amber-400 dark:bg-amber-900/60 dark:text-amber-50"
            >
              <AlertTriangle className="mt-0.5 h-7 w-7 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden />
              <div className="space-y-1">
                <p className="text-lg font-bold leading-tight">{t('auth.forgot.spamTitle')}</p>
                <p className="text-sm font-medium">{t('auth.forgot.spamBody')}</p>
              </div>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('auth.forgot.intro')}</p>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="email">
                {t('auth.email')}
              </label>
              <input
                id="email"
                type="email"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? t('auth.forgot.sending') : t('auth.forgot.submit')}
            </button>
          </form>
        )}
        <p className="text-center text-sm text-muted-foreground">
          <Link to="/login" className="font-medium text-primary hover:underline">
            {t('auth.backToSignIn')}
          </Link>
        </p>
      </div>
    </main>
  );
}
