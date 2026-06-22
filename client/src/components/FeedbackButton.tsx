import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useT } from '@/lib/useT';
import { useAuthStore } from '@/store/authStore';
import type { Feedback, FeedbackType } from '@tournament-predictor/shared';

const FEEDBACK_TYPES: FeedbackType[] = ['feature_request', 'improvement', 'bug'];

const STATUS_COLORS: Record<string, string> = {
  pending: 'text-muted-foreground',
  will_do: 'text-blue-500',
  implemented: 'text-green-500',
  fixed: 'text-green-500',
  wont_do: 'text-red-400',
};

export default function FeedbackButton() {
  const { t } = useT();
  const { user } = useAuthStore();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'new' | 'my'>('new');
  const [type, setType] = useState<FeedbackType>('improvement');
  const [message, setMessage] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const { data: myFeedback } = useQuery({
    queryKey: ['feedback-my'],
    queryFn: () => api.get<Feedback[]>('/feedback/my'),
    enabled: open && tab === 'my',
  });

  const submitMutation = useMutation({
    mutationFn: () => api.post<Feedback>('/feedback', { type, message }),
    onSuccess: () => {
      setSubmitted(true);
      setMessage('');
      queryClient.invalidateQueries({ queryKey: ['feedback-my'] });
    },
  });

  if (!user || user.isAdmin) return null;

  function handleClose() {
    setOpen(false);
    setSubmitted(false);
    setTab('new');
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={t('feedback.buttonTitle')}
        className="fixed bottom-5 left-5 z-40 flex h-11 w-11 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-colors"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>

      {open && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-4">
          <div className="w-full max-w-md rounded-xl border bg-background shadow-xl">
            <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b">
              <h2 className="font-semibold text-base">{t('feedback.modalTitle')}</h2>
              <button onClick={handleClose} className="text-muted-foreground hover:text-foreground transition-colors">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <div className="flex border-b">
              <button
                onClick={() => { setTab('new'); setSubmitted(false); }}
                className={`flex-1 py-2.5 text-sm font-medium transition-colors ${tab === 'new' ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {t('feedback.modalTitle')}
              </button>
              <button
                onClick={() => setTab('my')}
                className={`flex-1 py-2.5 text-sm font-medium transition-colors ${tab === 'my' ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {t('feedback.myFeedback')}
              </button>
            </div>

            <div className="p-5">
              {tab === 'new' ? (
                submitted ? (
                  <div className="py-6 text-center">
                    <p className="text-green-500 font-medium">{t('feedback.submitSuccess')}</p>
                    <button
                      onClick={() => setSubmitted(false)}
                      className="mt-4 text-sm text-muted-foreground hover:text-foreground underline"
                    >
                      {t('feedback.modalTitle')}
                    </button>
                  </div>
                ) : (
                  <form
                    onSubmit={(e) => { e.preventDefault(); submitMutation.mutate(); }}
                    className="space-y-4"
                  >
                    <div>
                      <label className="block text-sm font-medium mb-1.5">{t('feedback.typeLabel')}</label>
                      <div className="flex gap-2 flex-wrap">
                        {FEEDBACK_TYPES.map((ft) => (
                          <button
                            key={ft}
                            type="button"
                            onClick={() => setType(ft)}
                            className={`rounded-full px-3 py-1 text-sm border transition-colors ${
                              type === ft
                                ? 'bg-primary text-primary-foreground border-primary'
                                : 'border-border text-muted-foreground hover:border-foreground'
                            }`}
                          >
                            {t(`feedback.types.${ft}`)}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1.5">{t('feedback.messageLabel')}</label>
                      <textarea
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        placeholder={t('feedback.messagePlaceholder')}
                        rows={4}
                        required
                        className="w-full rounded-md border bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                      />
                    </div>

                    {submitMutation.isError && (
                      <p className="text-sm text-destructive">{t('feedback.submitFailed')}</p>
                    )}

                    <button
                      type="submit"
                      disabled={submitMutation.isPending || !message.trim()}
                      className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                    >
                      {submitMutation.isPending ? t('feedback.submitting') : t('feedback.submit')}
                    </button>
                  </form>
                )
              ) : (
                <div className="space-y-3 max-h-72 overflow-y-auto">
                  {!myFeedback ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">{t('common.loading')}</p>
                  ) : myFeedback.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">{t('feedback.noFeedback')}</p>
                  ) : (
                    myFeedback.map((fb) => (
                      <div key={fb.id} className="rounded-lg border p-3 text-sm">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            {t(`feedback.types.${fb.type}`)}
                          </span>
                          <span className={`text-xs font-medium ${STATUS_COLORS[fb.status] ?? ''}`}>
                            {t(`feedback.statuses.${fb.status}`)}
                          </span>
                        </div>
                        <p className="text-foreground/90 leading-snug">{fb.message}</p>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
