import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import LiveGateShell from '@/components/live/LiveGateShell';
import PlayerSearchInput from '@/components/PlayerSearchInput';
import TeamSelectInput from '@/components/TeamSelectInput';
import { useT } from '@/lib/useT';
import { EUROPEAN_COUNTRIES } from '@tournament-predictor/shared';
import type { LiveBonusQuestionView, Team } from '@tournament-predictor/shared';

// ── Step two: the bonus questions ─────────────────────────────────────────────
//
// One question per screen rather than the list the tab shows: this is the first-run flow,
// and a member who has just ordered 36 teams should be asked one thing at a time.
//
// Only questions that are still open and still unanswered are in the flow — a closed one
// can never be answered, so demanding it would trap the member out of the competition.
// The flow ends when the last one is saved, and the page then renders the competition.
//
// The controls are written here rather than shared with BonusQuestionsPanel: the panel's
// are small and inline next to a save button, these are large and alone on a dark screen.
// What is shared is what matters — the questions, the lock rule and the scoring all come
// from the same place.

interface Props {
  competitionName: string;
  /** Open, unanswered questions, in the order they were written. */
  questions: LiveBonusQuestionView[];
  teams: Team[];
  onSave: (questionId: string, answer: string) => Promise<unknown>;
  /** Called once every question in the flow has been answered. */
  onFinished: () => void;
}

export default function LiveBonusQuestionsGate({
  competitionName,
  questions,
  teams,
  onSave,
  onFinished,
}: Props) {
  const { t } = useT();
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string | null>(null);

  // The list is captured on mount by the page, so the index stays meaningful even as
  // answers land and the underlying query refetches.
  const question = questions[index] ?? null;
  const total = questions.length;
  const isLast = index === total - 1;

  // Each question starts empty rather than carrying the previous answer forward.
  useEffect(() => {
    setAnswer('');
    setError(null);
  }, [question?.id]);

  const saveMutation = useMutation({
    mutationFn: (value: string) => onSave(question!.id, value),
    onSuccess: () => {
      if (isLast) onFinished();
      else setIndex(i => i + 1);
    },
    onError: err =>
      setError(err instanceof ApiError ? err.message : t('live.bonus.saveFailed')),
  });

  // What this question accepts: the admin's list, or everything of that kind. A team
  // question keeps its picker and just offers fewer teams.
  const listedOptions = question?.options?.length ? question.options : null;
  const pickList = useMemo(
    () =>
      listedOptions ??
      (question?.answerType === 'country' ? [...EUROPEAN_COUNTRIES] : null),
    [listedOptions, question?.answerType],
  );
  const teamOptions = useMemo(
    () => (listedOptions ? teams.filter(team => listedOptions.includes(team.name)) : teams),
    [teams, listedOptions],
  );

  // The range is enforced here as well as on the server, so a value that would be refused
  // cannot be submitted in the first place.
  const outOfRange =
    question?.answerType === 'number' &&
    answer.trim() !== '' &&
    ((question.minValue != null && Number(answer) < question.minValue) ||
      (question.maxValue != null && Number(answer) > question.maxValue));

  const canSubmit = answer.trim().length > 0 && !outOfRange && !saveMutation.isPending;

  if (!question) return null;

  return (
    <LiveGateShell
      eyebrow={competitionName}
      title={t('live.bonus.gateTitle')}
      subtitle={t('live.bonus.gateSubtitle')}
      step={t('live.bonus.questionCounter', { current: index + 1, total })}
      footer={
        <>
          <button
            onClick={() => saveMutation.mutate(answer.trim())}
            disabled={!canSubmit}
            className="w-full rounded-md bg-white px-4 py-3 text-sm font-semibold text-slate-900 transition-colors hover:bg-white/90 disabled:opacity-40"
          >
            {saveMutation.isPending
              ? t('common.saving')
              : isLast
                ? t('live.bonus.finish')
                : t('live.bonus.next')}
          </button>
          {error ? (
            <p className="mt-2 text-center text-sm text-destructive">{error}</p>
          ) : (
            index > 0 && (
              <button
                onClick={() => setIndex(i => i - 1)}
                disabled={saveMutation.isPending}
                className="mt-2 w-full text-center text-xs text-white/50 underline-offset-4 hover:underline disabled:opacity-40"
              >
                {t('live.bonus.back')}
              </button>
            )
          )}
        </>
      }
    >
      <div className="rounded-lg border p-5">
        <h2 className="text-lg font-semibold">{question.question}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('live.bonus.worth', { points: question.points })}
        </p>

        <div className="mt-5">
          {question.answerType === 'yes_no' ? (
            <div className="grid grid-cols-2 gap-3">
              {(['Yes', 'No'] as const).map(option => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setAnswer(option)}
                  className={`rounded-md border px-4 py-4 text-sm font-medium transition-colors ${
                    answer === option
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'hover:bg-muted'
                  }`}
                >
                  {option === 'Yes'
                    ? t('bonusQuestions.yesAnswer')
                    : t('bonusQuestions.noAnswer')}
                </button>
              ))}
            </div>
          ) : question.answerType === 'country' ||
            (question.answerType === 'player' && pickList) ? (
            <select
              value={answer}
              onChange={e => setAnswer(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">{t('bonusQuestions.chooseAnswer')}</option>
              {(pickList ?? []).map(option => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : question.answerType === 'player' ? (
            <PlayerSearchInput
              value={answer}
              onChange={setAnswer}
              placeholder={t('bonusQuestions.searchPlayerUser')}
              // An answer is required to get past this screen, so a typed name has to be
              // enough on its own — the suggestions come from an external service that a
              // firewall or an outage can put out of reach.
              allowFreeText
            />
          ) : question.answerType === 'team' ? (
            <TeamSelectInput value={answer} onChange={setAnswer} teams={teamOptions} />
          ) : (
            <input
              type="number"
              value={answer}
              min={question.minValue ?? undefined}
              max={question.maxValue ?? undefined}
              onChange={e => setAnswer(e.target.value)}
              placeholder={t('bonusQuestions.yourAnswer')}
              className="w-full rounded-md border px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-ring [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          )}

          {/* What the question will accept, said before it is refused. */}
          {question.answerType === 'number' &&
            (question.minValue != null || question.maxValue != null) && (
              <p className={`mt-2 text-xs ${outOfRange ? 'text-destructive' : 'text-muted-foreground'}`}>
                {t('bonusQuestions.constraints.rangeHint', {
                  min: question.minValue ?? '−∞',
                  max: question.maxValue ?? '∞',
                })}
              </p>
            )}
          {question.answerType === 'number' && question.leeway != null && question.leeway > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('bonusQuestions.constraints.leewayHint', { leeway: question.leeway })}
            </p>
          )}
        </div>
      </div>
    </LiveGateShell>
  );
}
