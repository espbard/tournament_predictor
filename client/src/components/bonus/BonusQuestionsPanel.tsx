import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import PlayerSearchInput from '@/components/PlayerSearchInput';
import TeamSelectInput from '@/components/TeamSelectInput';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useT } from '@/lib/useT';
import type { BonusAnswerType, Team } from '@tournament-predictor/shared';

// ── Bonus questions ───────────────────────────────────────────────────────────
//
// The whole bonus UI — admin authoring, the answer inputs, the correct-answer display —
// with no idea which tournament type it is serving. Both types ask the same thing of a
// user, so both render this; what differs is where the data comes from and when a
// question closes, and those arrive as props.
//
// Manual tournaments wrap it in pages/BonusQuestionsTab.tsx (one deadline for the whole
// competition); live tournaments in components/live/LiveBonusQuestionsTab.tsx (a deadline
// per question, since a live competition has no competition-wide one).

export function parseCorrectAnswers(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
  } catch {}
  return [raw];
}

export function serializeCorrectAnswers(answers: string[]): string | null {
  if (answers.length === 0) return null;
  if (answers.length === 1) return answers[0];
  return JSON.stringify(answers);
}

/** A question, as either tournament type stores it. */
export interface BonusQuestionLike {
  id: string;
  question: string;
  answerType: BonusAnswerType;
  points: number;
  correctAnswer: string | null;
  /**
   * Per-question deadline state. When undefined the panel falls back to `deadlinePassed`,
   * which is how the manual type — one deadline for the whole competition — works.
   */
  isLocked?: boolean;
  /**
   * When a question closes, in words. Rendered under the question, and only worth setting
   * where the deadline is not already visible elsewhere on the page — which is the live
   * type, whose only deadline is the question's own.
   */
  deadlineLabel?: string | null;
}

export interface BonusAnswerLike {
  questionId: string;
  answer: string;
  points: number | null;
}

/** The calls the panel makes. Each tournament type supplies its own endpoints. */
export interface BonusPanelApi {
  createQuestion(body: { question: string; answerType: BonusAnswerType; points: number }): Promise<unknown>;
  updateQuestion(
    questionId: string,
    body: { question?: string; answerType?: BonusAnswerType; points?: number; correctAnswer?: string | null },
  ): Promise<unknown>;
  deleteQuestion(questionId: string): Promise<unknown>;
  saveAnswer(questionId: string, answer: string): Promise<unknown>;
}

interface Props {
  questions: BonusQuestionLike[];
  answers: BonusAnswerLike[];
  /** For rendering a team answer with its badge. Live tournaments map their crests onto this. */
  teams: Team[];
  isLoading?: boolean;
  /** Whole-panel lock, used for any question that does not carry its own `isLocked`. */
  deadlinePassed: boolean;
  /** Whether to show the admin authoring controls. */
  canManage: boolean;
  /** Set when looking at somebody else's answers, which turns the whole panel read-only. */
  viewUserId?: string;
  api: BonusPanelApi;
  /** Called after a question changes, so the owner can refetch. */
  onQuestionsChanged: () => void;
  /** Called after an answer is saved. */
  onAnswersChanged: () => void;
}

const CREATABLE_TYPES: BonusAnswerType[] = ['number', 'yes_no', 'player', 'team'];

export default function BonusQuestionsPanel({
  questions,
  answers,
  teams,
  isLoading = false,
  deadlinePassed,
  canManage,
  viewUserId,
  api,
  onQuestionsChanged,
  onAnswersChanged,
}: Props) {
  const { t } = useT();

  const ANSWER_TYPE_LABELS: Record<BonusAnswerType, string> = {
    number: t('bonusQuestions.answerTypes.number'),
    player: t('bonusQuestions.answerTypes.player'),
    team: t('bonusQuestions.answerTypes.team'),
    yes_no: t('bonusQuestions.answerTypes.yes_no'),
  };

  const [newQuestion, setNewQuestion] = useState('');
  const [newAnswerType, setNewAnswerType] = useState<BonusAnswerType>('number');
  const [newPoints, setNewPoints] = useState('');
  const [addError, setAddError] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editQuestion, setEditQuestion] = useState('');
  const [editAnswerType, setEditAnswerType] = useState<BonusAnswerType>('number');
  const [editPoints, setEditPoints] = useState('');
  const [editError, setEditError] = useState('');

  const [settingAnswerFor, setSettingAnswerFor] = useState<string | null>(null);
  const [correctAnswerInput, setCorrectAnswerInput] = useState('');
  const [correctAnswerList, setCorrectAnswerList] = useState<string[]>([]);
  const [setAnswerError, setSetAnswerError] = useState('');

  const [localAnswers, setLocalAnswers] = useState<Record<string, string>>({});
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});

  const answerMap = Object.fromEntries(answers.map(a => [a.questionId, a]));

  const addMutation = useMutation({
    mutationFn: (body: { question: string; answerType: BonusAnswerType; points: number }) =>
      api.createQuestion(body),
    onSuccess: () => {
      setNewQuestion('');
      setNewPoints('');
      setAddError('');
      onQuestionsChanged();
    },
    onError: (err) => setAddError(err instanceof ApiError ? err.message : t('bonusQuestions.failedToAdd')),
  });

  const editMutation = useMutation({
    mutationFn: ({ qid, ...body }: { qid: string; question: string; answerType: BonusAnswerType; points: number }) =>
      api.updateQuestion(qid, body),
    onSuccess: () => {
      setEditingId(null);
      setEditError('');
      onQuestionsChanged();
    },
    onError: (err) => setEditError(err instanceof ApiError ? err.message : t('bonusQuestions.failedToUpdate')),
  });

  const deleteMutation = useMutation({
    mutationFn: (qid: string) => api.deleteQuestion(qid),
    onSuccess: () => onQuestionsChanged(),
  });

  const setAnswerMutation = useMutation({
    mutationFn: ({ qid, correctAnswer }: { qid: string; correctAnswer: string | null }) =>
      api.updateQuestion(qid, { correctAnswer }),
    onSuccess: () => {
      setSettingAnswerFor(null);
      setCorrectAnswerInput('');
      setSetAnswerError('');
      onQuestionsChanged();
    },
    onError: (err) => setSetAnswerError(err instanceof ApiError ? err.message : t('bonusQuestions.failedToSetAnswer')),
  });

  function handleAddQuestion(e: React.FormEvent) {
    e.preventDefault();
    const pts = parseInt(newPoints, 10);
    if (!newQuestion.trim() || isNaN(pts) || pts < 1) {
      setAddError(t('bonusQuestions.fillAllFields'));
      return;
    }
    addMutation.mutate({ question: newQuestion.trim(), answerType: newAnswerType, points: pts });
  }

  function openEdit(q: BonusQuestionLike) {
    setEditingId(q.id);
    setEditQuestion(q.question);
    setEditAnswerType(CREATABLE_TYPES.includes(q.answerType) ? q.answerType : 'number');
    setEditPoints(String(q.points));
    setEditError('');
    setSettingAnswerFor(null);
  }

  function handleEditSave(qid: string) {
    const pts = parseInt(editPoints, 10);
    if (!editQuestion.trim() || isNaN(pts) || pts < 1) {
      setEditError(t('bonusQuestions.fillAllFields'));
      return;
    }
    editMutation.mutate({ qid, question: editQuestion.trim(), answerType: editAnswerType, points: pts });
  }

  function openSetAnswer(q: BonusQuestionLike) {
    setSettingAnswerFor(q.id);
    if (q.answerType === 'player' || q.answerType === 'team') {
      setCorrectAnswerList(parseCorrectAnswers(q.correctAnswer));
      setCorrectAnswerInput('');
    } else {
      setCorrectAnswerInput(q.correctAnswer ?? '');
      setCorrectAnswerList([]);
    }
    setSetAnswerError('');
    setEditingId(null);
  }

  async function saveAnswer(questionId: string, value?: string) {
    const answer = value ?? localAnswers[questionId];
    if (!answer?.trim()) return;
    setSavingIds(prev => new Set([...prev, questionId]));
    setSaveErrors(prev => { const n = { ...prev }; delete n[questionId]; return n; });
    try {
      await api.saveAnswer(questionId, answer.trim());
      onAnswersChanged();
      setSavedIds(prev => new Set([...prev, questionId]));
      setTimeout(() => setSavedIds(prev => { const n = new Set(prev); n.delete(questionId); return n; }), 2000);
    } catch (err) {
      setSaveErrors(prev => ({ ...prev, [questionId]: err instanceof ApiError ? err.message : t('bonusQuestions.saveFailed') }));
    } finally {
      setSavingIds(prev => { const n = new Set(prev); n.delete(questionId); return n; });
    }
  }

  function setLocalAnswer(qid: string, val: string) {
    setLocalAnswers(prev => ({ ...prev, [qid]: val }));
  }

  function handleYesNo(qid: string, val: 'Yes' | 'No') {
    setLocalAnswer(qid, val);
    saveAnswer(qid, val);
  }

  if (isLoading) return <LoadingSpinner />;

  return (
    <div className="space-y-6">
      {/* Admin: add question form */}
      {canManage && !viewUserId && (
        <form onSubmit={handleAddQuestion} className="rounded-lg border p-5 space-y-4">
          <h2 className="font-semibold">{t('bonusQuestions.addTitle')}</h2>
          <div>
            <label className="mb-1 block text-sm font-medium">{t('bonusQuestions.question')}</label>
            <input
              type="text"
              value={newQuestion}
              onChange={e => setNewQuestion(e.target.value)}
              placeholder="e.g. How many goals will Erling Haaland score?"
              className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex flex-wrap gap-6">
            <div>
              <label className="mb-2 block text-sm font-medium">{t('bonusQuestions.answerType')}</label>
              <div className="flex flex-wrap gap-4">
                {CREATABLE_TYPES.map(type => (
                  <label key={type} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="newAnswerType"
                      value={type}
                      checked={newAnswerType === type}
                      onChange={() => setNewAnswerType(type)}
                    />
                    {ANSWER_TYPE_LABELS[type]}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">{t('bonusQuestions.points')}</label>
              <input
                type="number"
                min={1}
                value={newPoints}
                onChange={e => setNewPoints(e.target.value)}
                placeholder="e.g. 5"
                className="w-24 rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
            </div>
          </div>
          {addError && <p className="text-sm text-destructive">{addError}</p>}
          <button
            type="submit"
            disabled={addMutation.isPending}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {addMutation.isPending ? t('bonusQuestions.adding') : t('bonusQuestions.addQuestion')}
          </button>
        </form>
      )}

      {/* Question list */}
      {questions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('bonusQuestions.noQuestions')}</p>
      ) : (
        <div className="space-y-3">
          {questions.map(q => {
            const myAnswer = answerMap[q.id];
            const localVal = localAnswers[q.id] ?? myAnswer?.answer ?? '';
            const saving = savingIds.has(q.id);
            const justSaved = savedIds.has(q.id);
            const saveErr = saveErrors[q.id];
            // The manual type locks the whole panel at once; the live type locks each
            // question on its own schedule, and says so through `isLocked`.
            const locked = q.isLocked ?? deadlinePassed;
            const isEditing = editingId === q.id;
            const isSettingAnswer = settingAnswerFor === q.id;
            const typeLabel = ANSWER_TYPE_LABELS[q.answerType] ?? q.answerType;

            return (
              <div key={q.id} className="rounded-lg border p-4 space-y-3">
                {/* Question header */}
                {!isEditing && (
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm">{q.question}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {typeLabel} · {q.points} {q.points === 1 ? t('bonusQuestions.pt') : t('bonusQuestions.pts')}
                        {q.deadlineLabel ? ` · ${q.deadlineLabel}` : ''}
                      </p>
                    </div>
                    {canManage && !viewUserId && (
                      <div className="flex gap-2 flex-shrink-0">
                        <button
                          onClick={() => openEdit(q)}
                          className="text-xs rounded border px-2.5 py-1 hover:bg-muted"
                        >
                          {t('common.edit')}
                        </button>
                        <button
                          onClick={() => openSetAnswer(q)}
                          className="text-xs rounded border px-2.5 py-1 hover:bg-muted"
                        >
                          {t('bonusQuestions.setAnswer')}
                        </button>
                        {q.correctAnswer !== null && (
                          <button
                            onClick={() => setAnswerMutation.mutate({ qid: q.id, correctAnswer: null })}
                            disabled={setAnswerMutation.isPending}
                            className="text-xs rounded border border-destructive/30 px-2.5 py-1 text-destructive hover:bg-destructive/10 disabled:opacity-50"
                          >
                            {t('bonusQuestions.removeAnswer')}
                          </button>
                        )}
                        <button
                          onClick={() => deleteMutation.mutate(q.id)}
                          disabled={deleteMutation.isPending}
                          className="text-xs rounded border border-destructive/30 px-2.5 py-1 text-destructive hover:bg-destructive/10 disabled:opacity-50"
                        >
                          {t('common.delete')}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Admin: edit question form */}
                {canManage && !viewUserId && isEditing && (
                  <div className="space-y-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('bonusQuestions.question')}</label>
                      <input
                        type="text"
                        value={editQuestion}
                        onChange={e => setEditQuestion(e.target.value)}
                        className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </div>
                    <div className="flex flex-wrap gap-6">
                      <div>
                        <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{t('bonusQuestions.answerType')}</label>
                        <div className="flex flex-wrap gap-4">
                          {CREATABLE_TYPES.map(type => (
                            <label key={type} className="flex items-center gap-2 text-sm cursor-pointer">
                              <input
                                type="radio"
                                name={`editAnswerType-${q.id}`}
                                value={type}
                                checked={editAnswerType === type}
                                onChange={() => setEditAnswerType(type)}
                              />
                              {ANSWER_TYPE_LABELS[type]}
                            </label>
                          ))}
                        </div>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('bonusQuestions.points')}</label>
                        <input
                          type="number"
                          min={1}
                          value={editPoints}
                          onChange={e => setEditPoints(e.target.value)}
                          className="w-24 rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        />
                      </div>
                    </div>
                    {editError && <p className="text-xs text-destructive">{editError}</p>}
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleEditSave(q.id)}
                        disabled={editMutation.isPending}
                        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                      >
                        {editMutation.isPending ? t('common.saving') : t('common.save')}
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                  </div>
                )}

                {/* Admin: set correct answer */}
                {canManage && !viewUserId && isSettingAnswer && !isEditing && (
                  <div className="space-y-2 pt-1 border-t">
                    <label className="text-xs font-medium text-muted-foreground">{t('bonusQuestions.correctAnswer')}</label>
                    <div className="space-y-2">
                      {q.answerType === 'yes_no' ? (
                        <div className="flex gap-2">
                          {(['Yes', 'No'] as const).map(opt => (
                            <button
                              key={opt}
                              type="button"
                              onClick={() => setCorrectAnswerInput(opt)}
                              className={`px-6 py-2 rounded-md border text-sm font-medium transition-colors ${
                                correctAnswerInput === opt
                                  ? 'bg-primary text-primary-foreground border-primary'
                                  : 'hover:bg-muted'
                              }`}
                            >
                              {opt === 'Yes' ? t('bonusQuestions.yesAnswer') : t('bonusQuestions.noAnswer')}
                            </button>
                          ))}
                        </div>
                      ) : q.answerType === 'player' ? (
                        <div className="space-y-2">
                          {correctAnswerList.map((item, i) => (
                            <div key={i} className="flex items-center gap-2 rounded-md border bg-muted px-3 py-1.5">
                              <span className="flex-1 text-sm">{item}</span>
                              <button
                                type="button"
                                onClick={() => setCorrectAnswerList(prev => prev.filter((_, j) => j !== i))}
                                className="text-xs text-destructive hover:text-destructive/80"
                              >
                                ×
                              </button>
                            </div>
                          ))}
                          <div className="flex gap-2">
                            <div className="flex-1">
                              <PlayerSearchInput
                                value={correctAnswerInput}
                                onChange={setCorrectAnswerInput}
                                placeholder={t('bonusQuestions.searchPlayer')}
                              />
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                const v = correctAnswerInput.trim();
                                if (v && !correctAnswerList.includes(v)) {
                                  setCorrectAnswerList(prev => [...prev, v]);
                                  setCorrectAnswerInput('');
                                }
                              }}
                              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                            >
                              {t('common.add')}
                            </button>
                          </div>
                        </div>
                      ) : q.answerType === 'team' ? (
                        <div className="space-y-2">
                          {correctAnswerList.map((item, i) => {
                            const teamObj = teams.find(tm => tm.name === item);
                            return (
                              <div key={i} className="flex items-center gap-2 rounded-md border bg-muted px-3 py-1.5">
                                {teamObj?.imageUrl && (
                                  <img src={teamObj.imageUrl} alt="" className="h-4 w-4 rounded-full object-cover" />
                                )}
                                <span className="flex-1 text-sm">{item}</span>
                                <button
                                  type="button"
                                  onClick={() => setCorrectAnswerList(prev => prev.filter((_, j) => j !== i))}
                                  className="text-xs text-destructive hover:text-destructive/80"
                                >
                                  ×
                                </button>
                              </div>
                            );
                          })}
                          <div className="flex gap-2">
                            <div className="flex-1">
                              <TeamSelectInput
                                value={correctAnswerInput}
                                onChange={setCorrectAnswerInput}
                                teams={teams}
                              />
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                const v = correctAnswerInput.trim();
                                if (v && !correctAnswerList.includes(v)) {
                                  setCorrectAnswerList(prev => [...prev, v]);
                                  setCorrectAnswerInput('');
                                }
                              }}
                              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                            >
                              {t('common.add')}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <input
                          type="number"
                          value={correctAnswerInput}
                          onChange={e => setCorrectAnswerInput(e.target.value)}
                          placeholder={t('bonusQuestions.enterCorrectAnswer')}
                          className="w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        />
                      )}
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            const answer = (q.answerType === 'player' || q.answerType === 'team')
                              ? serializeCorrectAnswers(correctAnswerList)
                              : (correctAnswerInput.trim() || null);
                            setAnswerMutation.mutate({ qid: q.id, correctAnswer: answer });
                          }}
                          disabled={setAnswerMutation.isPending}
                          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                        >
                          {t('common.save')}
                        </button>
                        <button
                          onClick={() => setSettingAnswerFor(null)}
                          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                        >
                          {t('common.cancel')}
                        </button>
                      </div>
                      {setAnswerError && <p className="text-xs text-destructive">{setAnswerError}</p>}
                    </div>
                  </div>
                )}

                {/* Admin: show stored correct answer (idle state) */}
                {canManage && !viewUserId && !isSettingAnswer && !isEditing && q.correctAnswer !== null && (
                  <CorrectAnswerDisplay type={q.answerType} value={q.correctAnswer} teams={teams} correctAnswerLabel={t('bonusQuestions.correctAnswer')} />
                )}

                {/* Read-only view of another user's answer */}
                {viewUserId && (
                  <div className="pt-1 border-t space-y-2">
                    <AnswerReadOnly
                      type={q.answerType}
                      value={myAnswer?.answer ?? ''}
                      teams={teams}
                      noAnswerLabel={t('bonusQuestions.noAnswerSubmitted')}
                    />
                    {myAnswer?.points !== null && myAnswer?.points !== undefined && (
                      <span className="text-sm font-medium text-green-600">+{myAnswer.points} pts</span>
                    )}
                    {q.correctAnswer !== null && q.correctAnswer !== undefined && (
                      <CorrectAnswerDisplay
                        type={q.answerType}
                        value={q.correctAnswer}
                        teams={teams}
                        correctAnswerLabel={t('bonusQuestions.correctAnswer')}
                      />
                    )}
                  </div>
                )}

                {/* User: answer input */}
                {!viewUserId && !canManage && (
                  <div className="pt-1 border-t space-y-2">
                    {q.answerType === 'yes_no' ? (
                      <div className="flex items-center gap-3">
                        <div className="flex gap-2">
                          {(['Yes', 'No'] as const).map(opt => (
                            <button
                              key={opt}
                              type="button"
                              onClick={() => !locked && handleYesNo(q.id, opt)}
                              disabled={locked || saving}
                              className={`px-6 py-2 rounded-md border text-sm font-medium transition-colors disabled:cursor-not-allowed ${
                                localVal === opt
                                  ? 'bg-primary text-primary-foreground border-primary'
                                  : locked
                                  ? 'opacity-50'
                                  : 'hover:bg-muted'
                              }`}
                            >
                              {opt === 'Yes' ? t('bonusQuestions.yesAnswer') : t('bonusQuestions.noAnswer')}
                            </button>
                          ))}
                        </div>
                        {saving && <span className="text-xs text-muted-foreground">…</span>}
                        {justSaved && <span className="text-xs text-green-600">{t('bonusQuestions.savedBang')}</span>}
                        {myAnswer?.points !== null && myAnswer?.points !== undefined && (
                          <span className="text-sm font-medium text-green-600">+{myAnswer.points} pts</span>
                        )}
                      </div>
                    ) : q.answerType === 'player' ? (
                      <>
                        <PlayerSearchInput
                          value={localVal}
                          onChange={val => setLocalAnswer(q.id, val)}
                          disabled={locked}
                          placeholder={locked ? (myAnswer?.answer || '—') : t('bonusQuestions.searchPlayerUser')}
                        />
                        <SaveRow
                          deadlinePassed={locked}
                          hasValue={!!localVal.trim()}
                          saving={saving}
                          justSaved={justSaved}
                          points={myAnswer?.points ?? null}
                          onSave={() => saveAnswer(q.id)}
                          saveLabel={t('common.save')}
                          savedLabel={t('bonusQuestions.savedBang')}
                        />
                      </>
                    ) : q.answerType === 'team' ? (
                      <>
                        {locked ? (
                          <AnswerReadOnly type={q.answerType} value={myAnswer?.answer ?? ''} teams={teams} noAnswerLabel={t('bonusQuestions.noAnswerSubmitted')} />
                        ) : (
                          <TeamSelectInput
                            value={localVal}
                            onChange={val => setLocalAnswer(q.id, val)}
                            teams={teams}
                          />
                        )}
                        {!locked && (
                          <SaveRow
                            deadlinePassed={locked}
                            hasValue={!!localVal.trim()}
                            saving={saving}
                            justSaved={justSaved}
                            points={myAnswer?.points ?? null}
                            onSave={() => saveAnswer(q.id)}
                            saveLabel={t('common.save')}
                            savedLabel={t('bonusQuestions.savedBang')}
                          />
                        )}
                        {locked && myAnswer?.points !== null && myAnswer?.points !== undefined && (
                          <span className="text-sm font-medium text-green-600">+{myAnswer.points} pts</span>
                        )}
                      </>
                    ) : (
                      <>
                        <input
                          type="number"
                          value={localVal}
                          onChange={e => setLocalAnswer(q.id, e.target.value)}
                          disabled={locked}
                          placeholder={locked ? (myAnswer?.answer ?? '—') : t('bonusQuestions.yourAnswer')}
                          className="w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:bg-muted disabled:text-muted-foreground [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        />
                        <SaveRow
                          deadlinePassed={locked}
                          hasValue={!!localVal.trim()}
                          saving={saving}
                          justSaved={justSaved}
                          points={myAnswer?.points ?? null}
                          onSave={() => saveAnswer(q.id)}
                          saveLabel={t('common.save')}
                          savedLabel={t('bonusQuestions.savedBang')}
                        />
                      </>
                    )}
                    {q.correctAnswer !== null && q.correctAnswer !== undefined && (
                      <CorrectAnswerDisplay
                        type={q.answerType}
                        value={q.correctAnswer}
                        teams={teams}
                        correctAnswerLabel={t('bonusQuestions.correctAnswer')}
                      />
                    )}
                    {saveErr && <p className="text-xs text-destructive">{saveErr}</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SaveRow({
  deadlinePassed, hasValue, saving, justSaved, points, onSave, saveLabel, savedLabel,
}: {
  deadlinePassed: boolean;
  hasValue: boolean;
  saving: boolean;
  justSaved: boolean;
  points: number | null;
  onSave: () => void;
  saveLabel: string;
  savedLabel: string;
}) {
  return (
    <div className="flex items-center gap-3">
      {!deadlinePassed && (
        <button
          onClick={onSave}
          disabled={saving || !hasValue}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? '…' : justSaved ? savedLabel : saveLabel}
        </button>
      )}
      {points !== null && points !== undefined && (
        <span className="text-sm font-medium text-green-600">+{points} pts</span>
      )}
    </div>
  );
}

function displayYesNo(type: BonusAnswerType | string, value: string, t: ReturnType<typeof useT>['t']): string {
  if (type !== 'yes_no') return value;
  if (value === 'Yes') return t('bonusQuestions.yesAnswer');
  if (value === 'No') return t('bonusQuestions.noAnswer');
  return value;
}

function CorrectAnswerDisplay({ type, value, teams, correctAnswerLabel }: { type: BonusAnswerType | string; value: string; teams: Team[]; correctAnswerLabel: string }) {
  const { t } = useT();
  const answers = parseCorrectAnswers(value);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground border-t pt-2">
      <span>{correctAnswerLabel}:</span>
      {answers.map((answer, i) => {
        const teamObj = type === 'team' ? teams.find(tm => tm.name === answer) : null;
        return (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-muted-foreground/50">·</span>}
            {teamObj?.imageUrl && (
              <img src={teamObj.imageUrl} alt="" className="h-4 w-4 rounded-full object-cover" />
            )}
            <span className="font-medium text-foreground">{displayYesNo(type, answer, t)}</span>
          </span>
        );
      })}
    </div>
  );
}

function AnswerReadOnly({ type, value, teams, noAnswerLabel }: { type: BonusAnswerType | string; value: string; teams: Team[]; noAnswerLabel: string }) {
  const { t } = useT();
  if (!value) return <p className="text-sm text-muted-foreground">{noAnswerLabel}</p>;
  const teamObj = type === 'team' ? teams.find(tm => tm.name === value) : null;
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2">
      {teamObj?.imageUrl && (
        <img src={teamObj.imageUrl} alt="" className="h-5 w-5 rounded-full object-cover flex-shrink-0" />
      )}
      <span className="text-sm text-muted-foreground">{displayYesNo(type, value, t)}</span>
    </div>
  );
}
