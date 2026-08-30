import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import PlayerSearchInput from '@/components/PlayerSearchInput';
import TeamSelectInput from '@/components/TeamSelectInput';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useT } from '@/lib/useT';
import { EUROPEAN_COUNTRIES } from '@tournament-predictor/shared';
import BonusConstraintsEditor, {
  EMPTY_CONSTRAINTS,
  constraintsFromQuestion,
  constraintsToPayload,
  type BonusConstraintsDraft,
} from '@/components/bonus/BonusConstraintsEditor';
import type { Team } from '@tournament-predictor/shared';

/**
 * The answer types the panel can render.
 *
 * A superset of the manual type's, since `country` exists only for live tournaments. Which
 * of them an admin may choose is the `answerTypes` prop — the manual form must not offer
 * one its tables cannot store.
 */
export type PanelAnswerType = 'number' | 'player' | 'team' | 'yes_no' | 'country';

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
  answerType: PanelAnswerType;
  points: number;
  correctAnswer: string | null;
  /**
   * Per-question deadline state. When undefined the panel falls back to `deadlinePassed`,
   * which is how the manual type — one deadline for the whole competition — works.
   */
  isLocked?: boolean;

  // ── Optional constraints, live tournaments only (shared/src/live/bonus.ts) ──
  /** Inclusive bounds on a number answer. */
  minValue?: number | null;
  maxValue?: number | null;
  /** A number answer within ±leeway of the correct one scores in full. */
  leeway?: number | null;
  /** The only answers a player, team or country question accepts. */
  options?: string[] | null;
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
export interface BonusConstraintsPayload {
  minValue: number | null;
  maxValue: number | null;
  leeway: number | null;
  options: string[] | null;
}

export interface BonusPanelApi {
  createQuestion(
    body: { question: string; answerType: PanelAnswerType; points: number } & Partial<BonusConstraintsPayload>,
  ): Promise<unknown>;
  updateQuestion(
    questionId: string,
    body: {
      question?: string;
      answerType?: PanelAnswerType;
      points?: number;
      correctAnswer?: string | null;
    } & Partial<BonusConstraintsPayload>,
  ): Promise<unknown>;
  deleteQuestion(questionId: string): Promise<unknown>;
  saveAnswer(questionId: string, answer: string): Promise<unknown>;
  /**
   * Delete every answer the viewer has given that a deadline has not closed yet. Optional:
   * the admin tournament page renders this panel with no competition behind it, and there
   * are no answers of one's own to clear there.
   */
  clearAnswers?(): Promise<unknown>;
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
  /**
   * The answer types an admin may choose here. Defaults to the manual type's four; live
   * tournaments pass their five, and only they can store the constraints below.
   */
  answerTypes?: PanelAnswerType[];
  /** Whether to offer the range, leeway and option-list editors. Live tournaments only. */
  supportsConstraints?: boolean;
}

const DEFAULT_ANSWER_TYPES: PanelAnswerType[] = ['number', 'yes_no', 'player', 'team'];

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
  answerTypes = DEFAULT_ANSWER_TYPES,
  supportsConstraints = false,
}: Props) {
  const { t } = useT();
  const CREATABLE_TYPES = answerTypes;

  const ANSWER_TYPE_LABELS: Record<PanelAnswerType, string> = {
    number: t('bonusQuestions.answerTypes.number'),
    player: t('bonusQuestions.answerTypes.player'),
    team: t('bonusQuestions.answerTypes.team'),
    yes_no: t('bonusQuestions.answerTypes.yes_no'),
    country: t('bonusQuestions.answerTypes.country'),
  };

  const [newQuestion, setNewQuestion] = useState('');
  const [newAnswerType, setNewAnswerType] = useState<PanelAnswerType>('number');
  const [newPoints, setNewPoints] = useState('');
  const [newConstraints, setNewConstraints] = useState<BonusConstraintsDraft>(EMPTY_CONSTRAINTS);
  const [addError, setAddError] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editQuestion, setEditQuestion] = useState('');
  const [editAnswerType, setEditAnswerType] = useState<PanelAnswerType>('number');
  const [editPoints, setEditPoints] = useState('');
  const [editConstraints, setEditConstraints] = useState<BonusConstraintsDraft>(EMPTY_CONSTRAINTS);
  const [editError, setEditError] = useState('');

  const [settingAnswerFor, setSettingAnswerFor] = useState<string | null>(null);
  const [correctAnswerInput, setCorrectAnswerInput] = useState('');
  const [correctAnswerList, setCorrectAnswerList] = useState<string[]>([]);
  const [setAnswerError, setSetAnswerError] = useState('');

  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearError, setClearError] = useState('');

  const [localAnswers, setLocalAnswers] = useState<Record<string, string>>({});
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});

  const answerMap = Object.fromEntries(answers.map(a => [a.questionId, a]));

  // Clearing is offered while there is something to clear that a deadline has not closed.
  // The manual type shuts every question at once (`deadlinePassed`); the live type shuts
  // them one at a time, so it is the individual question's lock that counts.
  const questionMap = Object.fromEntries(questions.map(q => [q.id, q]));
  const hasClearableAnswers = answers.some(a => {
    const q = questionMap[a.questionId];
    return q ? !(q.isLocked ?? deadlinePassed) : false;
  });
  const canClearAnswers = !!api.clearAnswers && !viewUserId && hasClearableAnswers;

  const addMutation = useMutation({
    mutationFn: (
      body: { question: string; answerType: PanelAnswerType; points: number } &
        Partial<BonusConstraintsPayload>,
    ) => api.createQuestion(body),
    onSuccess: () => {
      setNewQuestion('');
      setNewPoints('');
      setNewConstraints(EMPTY_CONSTRAINTS);
      setAddError('');
      onQuestionsChanged();
    },
    onError: (err) => setAddError(err instanceof ApiError ? err.message : t('bonusQuestions.failedToAdd')),
  });

  const editMutation = useMutation({
    mutationFn: ({
      qid,
      ...body
    }: { qid: string; question: string; answerType: PanelAnswerType; points: number } &
      Partial<BonusConstraintsPayload>) => api.updateQuestion(qid, body),
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

  const clearAnswersMutation = useMutation({
    mutationFn: () => api.clearAnswers!(),
    onSuccess: () => {
      // The inputs render `localAnswers` over the server's copy, so they have to be
      // dropped too — otherwise a cleared question still shows what was typed into it.
      setLocalAnswers({});
      setSavedIds(new Set());
      setSaveErrors({});
      setShowClearConfirm(false);
      setClearError('');
      onAnswersChanged();
    },
    onError: err =>
      setClearError(err instanceof ApiError ? err.message : t('bonusQuestions.failedToClear')),
  });

  function handleAddQuestion(e: React.FormEvent) {
    e.preventDefault();
    const pts = parseInt(newPoints, 10);
    if (!newQuestion.trim() || isNaN(pts) || pts < 1) {
      setAddError(t('bonusQuestions.fillAllFields'));
      return;
    }
    addMutation.mutate({
      question: newQuestion.trim(),
      answerType: newAnswerType,
      points: pts,
      ...(supportsConstraints ? constraintsToPayload(newConstraints, newAnswerType) : {}),
    });
  }

  function openEdit(q: BonusQuestionLike) {
    setEditingId(q.id);
    setEditQuestion(q.question);
    setEditAnswerType(CREATABLE_TYPES.includes(q.answerType) ? q.answerType : 'number');
    setEditPoints(String(q.points));
    setEditConstraints(constraintsFromQuestion(q));
    setEditError('');
    setSettingAnswerFor(null);
  }

  function handleEditSave(qid: string) {
    const pts = parseInt(editPoints, 10);
    if (!editQuestion.trim() || isNaN(pts) || pts < 1) {
      setEditError(t('bonusQuestions.fillAllFields'));
      return;
    }
    editMutation.mutate({
      qid,
      question: editQuestion.trim(),
      answerType: editAnswerType,
      points: pts,
      ...(supportsConstraints ? constraintsToPayload(editConstraints, editAnswerType) : {}),
    });
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
          {supportsConstraints && (
            <BonusConstraintsEditor
              answerType={newAnswerType}
              value={newConstraints}
              onChange={setNewConstraints}
              teams={teams}
            />
          )}
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

      {/* Clear my answers */}
      {canClearAnswers && (
        <div className="flex justify-end">
          <button
            onClick={() => {
              setClearError('');
              setShowClearConfirm(true);
            }}
            className="text-xs rounded border border-destructive/30 px-2.5 py-1 text-destructive hover:bg-destructive/5"
          >
            {t('bonusQuestions.clearAll')}
          </button>
        </div>
      )}

      {showClearConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-lg border bg-background p-6 shadow-xl">
            <p className="mb-1 font-semibold">{t('bonusQuestions.clearConfirm.title')}</p>
            <p className="mb-6 text-sm text-muted-foreground">
              {t('bonusQuestions.clearConfirm.body')}
            </p>
            {clearError && <p className="mb-4 text-sm text-destructive">{clearError}</p>}
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowClearConfirm(false)}
                disabled={clearAnswersMutation.isPending}
                className="rounded-md border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => clearAnswersMutation.mutate()}
                disabled={clearAnswersMutation.isPending}
                className="rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
              >
                {clearAnswersMutation.isPending
                  ? t('bonusQuestions.clearConfirm.clearing')
                  : t('bonusQuestions.clearConfirm.clear')}
              </button>
            </div>
          </div>
        </div>
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
            // A question may be narrowed to a list of answers; a country question is
            // narrowed to Europe even when the admin listed nothing. A team question keeps
            // its picker either way — the list just shrinks what it offers.
            const listedOptions = q.options?.length ? q.options : null;
            const pickList =
              listedOptions ?? (q.answerType === 'country' ? [...EUROPEAN_COUNTRIES] : null);
            const teamChoices = listedOptions
              ? teams.filter(team => listedOptions.includes(team.name))
              : teams;
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
                        {canManage && constraintSummary(q, t)
                          ? ` · ${constraintSummary(q, t)}`
                          : ''}
                      </p>
                      {!canManage && <ConstraintHints question={q} />}
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
                    {supportsConstraints && (
                      <BonusConstraintsEditor
                        answerType={editAnswerType}
                        value={editConstraints}
                        onChange={setEditConstraints}
                        teams={teams}
                      />
                    )}
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
                      ) : q.answerType === 'country' || (q.answerType === 'player' && pickList) ? (
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
                          <select
                            value=""
                            onChange={e => {
                              const v = e.target.value;
                              if (v && !correctAnswerList.includes(v)) {
                                setCorrectAnswerList(prev => [...prev, v]);
                              }
                            }}
                            className="w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          >
                            <option value="">{t('bonusQuestions.chooseAnswer')}</option>
                            {(pickList ?? [])
                              .filter(option => !correctAnswerList.includes(option))
                              .map(option => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                          </select>
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
                                teams={teamChoices}
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
                          min={q.minValue ?? undefined}
                          max={q.maxValue ?? undefined}
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
                    ) : q.answerType === 'country' || (q.answerType === 'player' && pickList) ? (
                      <>
                        <select
                          value={localVal}
                          disabled={locked}
                          onChange={e => setLocalAnswer(q.id, e.target.value)}
                          className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:bg-muted disabled:text-muted-foreground"
                        >
                          <option value="">{t('bonusQuestions.chooseAnswer')}</option>
                          {(pickList ?? []).map(option => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
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
                            teams={teamChoices}
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
                          min={q.minValue ?? undefined}
                          max={q.maxValue ?? undefined}
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

/**
 * What a number question will accept, and what counts as right, in words.
 *
 * Shown to whoever is answering — a leeway in particular changes how the question should
 * be read, and "±5" in the header line is not something to make a member decode.
 */
function ConstraintHints({ question }: { question: BonusQuestionLike }) {
  const { t } = useT();
  if (question.answerType !== 'number') return null;

  const hasRange = question.minValue != null || question.maxValue != null;
  const hasLeeway = question.leeway != null && question.leeway > 0;
  if (!hasRange && !hasLeeway) return null;

  return (
    <p className="mt-1 text-xs text-muted-foreground">
      {hasRange &&
        t('bonusQuestions.constraints.rangeHint', {
          min: question.minValue ?? '−∞',
          max: question.maxValue ?? '∞',
        })}
      {hasRange && hasLeeway && ' '}
      {hasLeeway && t('bonusQuestions.constraints.leewayHint', { leeway: question.leeway! })}
    </p>
  );
}

/** "0–5", "±5", "4 options" — whatever an admin narrowed, in a few characters. */
function constraintSummary(
  q: BonusQuestionLike,
  t: ReturnType<typeof useT>['t'],
): string | null {
  const parts: string[] = [];
  if (q.minValue != null || q.maxValue != null) {
    parts.push(`${q.minValue ?? '−∞'}–${q.maxValue ?? '∞'}`);
  }
  if (q.leeway != null && q.leeway > 0) parts.push(`±${q.leeway}`);
  if (q.options?.length) {
    parts.push(t('bonusQuestions.constraints.optionCount', { count: q.options.length }));
  }
  return parts.length > 0 ? parts.join(' · ') : null;
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

function displayYesNo(type: PanelAnswerType | string, value: string, t: ReturnType<typeof useT>['t']): string {
  if (type !== 'yes_no') return value;
  if (value === 'Yes') return t('bonusQuestions.yesAnswer');
  if (value === 'No') return t('bonusQuestions.noAnswer');
  return value;
}

function CorrectAnswerDisplay({ type, value, teams, correctAnswerLabel }: { type: PanelAnswerType | string; value: string; teams: Team[]; correctAnswerLabel: string }) {
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

function AnswerReadOnly({ type, value, teams, noAnswerLabel }: { type: PanelAnswerType | string; value: string; teams: Team[]; noAnswerLabel: string }) {
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
