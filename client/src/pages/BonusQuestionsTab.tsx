import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import PlayerSearchInput from '@/components/PlayerSearchInput';
import TeamSelectInput from '@/components/TeamSelectInput';
import type { BonusAnswerType, BonusQuestion, BonusAnswer, Team } from '@tournament-predictor/shared';

interface Props {
  tournamentId: string;
  competitionId?: string;
  deadlinePassed: boolean;
}

const ANSWER_TYPE_LABELS: Record<BonusAnswerType, string> = {
  number: 'Number',
  player: 'Player',
  team: 'Team',
  yes_no: 'Yes / No',
};

const CREATABLE_TYPES: BonusAnswerType[] = ['number', 'yes_no', 'player', 'team'];

export default function BonusQuestionsTab({ competitionId, tournamentId, deadlinePassed }: Props) {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();

  // Add form
  const [newQuestion, setNewQuestion] = useState('');
  const [newAnswerType, setNewAnswerType] = useState<BonusAnswerType>('number');
  const [newPoints, setNewPoints] = useState('');
  const [addError, setAddError] = useState('');

  // Edit question (admin)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editQuestion, setEditQuestion] = useState('');
  const [editAnswerType, setEditAnswerType] = useState<BonusAnswerType>('number');
  const [editPoints, setEditPoints] = useState('');
  const [editError, setEditError] = useState('');

  // Set correct answer (admin)
  const [settingAnswerFor, setSettingAnswerFor] = useState<string | null>(null);
  const [correctAnswerInput, setCorrectAnswerInput] = useState('');
  const [setAnswerError, setSetAnswerError] = useState('');

  // User answers
  const [localAnswers, setLocalAnswers] = useState<Record<string, string>>({});
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});

  const { data: questions = [], isLoading } = useQuery({
    queryKey: ['tournaments', tournamentId, 'bonus-questions'],
    queryFn: () => api.get<BonusQuestion[]>(`/tournaments/${tournamentId}/bonus-questions`),
  });

  const { data: myAnswers = [] } = useQuery({
    queryKey: ['competitions', competitionId, 'bonus-answers'],
    queryFn: () => api.get<BonusAnswer[]>(`/competitions/${competitionId}/bonus-answers`),
    enabled: !!competitionId,
  });

  const { data: teams = [] } = useQuery({
    queryKey: ['tournaments', tournamentId, 'teams'],
    queryFn: () => api.get<Team[]>(`/tournaments/${tournamentId}/teams`),
    enabled: questions.some(q => q.answerType === 'team'),
  });

  const answerMap = Object.fromEntries(myAnswers.map(a => [a.questionId, a]));

  // ── Mutations ─────────────────────────────────────────────────────────────────

  const addMutation = useMutation({
    mutationFn: (body: { question: string; answerType: BonusAnswerType; points: number }) =>
      api.post<BonusQuestion>(`/tournaments/${tournamentId}/bonus-questions`, body),
    onSuccess: () => {
      setNewQuestion('');
      setNewPoints('');
      setAddError('');
      queryClient.invalidateQueries({ queryKey: ['tournaments', tournamentId, 'bonus-questions'] });
    },
    onError: (err) => setAddError(err instanceof ApiError ? err.message : 'Failed to add question'),
  });

  const editMutation = useMutation({
    mutationFn: ({ qid, ...body }: { qid: string; question: string; answerType: BonusAnswerType; points: number }) =>
      api.patch<BonusQuestion>(`/tournaments/${tournamentId}/bonus-questions/${qid}`, body),
    onSuccess: () => {
      setEditingId(null);
      setEditError('');
      queryClient.invalidateQueries({ queryKey: ['tournaments', tournamentId, 'bonus-questions'] });
    },
    onError: (err) => setEditError(err instanceof ApiError ? err.message : 'Failed to update question'),
  });

  const deleteMutation = useMutation({
    mutationFn: (qid: string) =>
      api.delete(`/tournaments/${tournamentId}/bonus-questions/${qid}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tournaments', tournamentId, 'bonus-questions'] }),
  });

  const setAnswerMutation = useMutation({
    mutationFn: ({ qid, correctAnswer }: { qid: string; correctAnswer: string | null }) =>
      api.patch<BonusQuestion>(`/tournaments/${tournamentId}/bonus-questions/${qid}`, { correctAnswer }),
    onSuccess: () => {
      setSettingAnswerFor(null);
      setCorrectAnswerInput('');
      setSetAnswerError('');
      queryClient.invalidateQueries({ queryKey: ['tournaments', tournamentId, 'bonus-questions'] });
    },
    onError: (err) => setSetAnswerError(err instanceof ApiError ? err.message : 'Failed to set answer'),
  });

  // ── Handlers ──────────────────────────────────────────────────────────────────

  function handleAddQuestion(e: React.FormEvent) {
    e.preventDefault();
    const pts = parseInt(newPoints, 10);
    if (!newQuestion.trim() || isNaN(pts) || pts < 1) {
      setAddError('Fill in all fields correctly');
      return;
    }
    addMutation.mutate({ question: newQuestion.trim(), answerType: newAnswerType, points: pts });
  }

  function openEdit(q: BonusQuestion) {
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
      setEditError('Fill in all fields correctly');
      return;
    }
    editMutation.mutate({ qid, question: editQuestion.trim(), answerType: editAnswerType, points: pts });
  }

  function openSetAnswer(q: BonusQuestion) {
    setSettingAnswerFor(q.id);
    setCorrectAnswerInput(q.correctAnswer ?? '');
    setSetAnswerError('');
    setEditingId(null);
  }

  async function saveAnswer(questionId: string, value?: string) {
    if (!competitionId) return;
    const answer = value ?? localAnswers[questionId];
    if (!answer?.trim()) return;
    setSavingIds(prev => new Set([...prev, questionId]));
    setSaveErrors(prev => { const n = { ...prev }; delete n[questionId]; return n; });
    try {
      await api.post(`/competitions/${competitionId}/bonus-answers`, { questionId, answer: answer.trim() });
      queryClient.invalidateQueries({ queryKey: ['competitions', competitionId, 'bonus-answers'] });
      setSavedIds(prev => new Set([...prev, questionId]));
      setTimeout(() => setSavedIds(prev => { const n = new Set(prev); n.delete(questionId); return n; }), 2000);
    } catch (err) {
      setSaveErrors(prev => ({ ...prev, [questionId]: err instanceof ApiError ? err.message : 'Failed to save' }));
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

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-6">
      {/* Admin: add question form */}
      {user?.isAdmin && (
        <form onSubmit={handleAddQuestion} className="rounded-lg border p-5 space-y-4">
          <h2 className="font-semibold">Add Bonus Question</h2>
          <div>
            <label className="mb-1 block text-sm font-medium">Question</label>
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
              <label className="mb-2 block text-sm font-medium">Answer type</label>
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
              <label className="mb-1 block text-sm font-medium">Points</label>
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
            {addMutation.isPending ? 'Adding…' : 'Add Question'}
          </button>
        </form>
      )}

      {/* Question list */}
      {questions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No bonus questions yet.</p>
      ) : (
        <div className="space-y-3">
          {questions.map(q => {
            const myAnswer = answerMap[q.id];
            const localVal = localAnswers[q.id] ?? myAnswer?.answer ?? '';
            const saving = savingIds.has(q.id);
            const justSaved = savedIds.has(q.id);
            const saveErr = saveErrors[q.id];
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
                        {typeLabel} · {q.points} {q.points === 1 ? 'pt' : 'pts'}
                      </p>
                    </div>
                    {user?.isAdmin && (
                      <div className="flex gap-2 flex-shrink-0">
                        <button
                          onClick={() => openEdit(q)}
                          className="text-xs rounded border px-2.5 py-1 hover:bg-muted"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => openSetAnswer(q)}
                          className="text-xs rounded border px-2.5 py-1 hover:bg-muted"
                        >
                          Set answer
                        </button>
                        <button
                          onClick={() => deleteMutation.mutate(q.id)}
                          disabled={deleteMutation.isPending}
                          className="text-xs rounded border border-destructive/30 px-2.5 py-1 text-destructive hover:bg-destructive/10 disabled:opacity-50"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Admin: edit question form */}
                {user?.isAdmin && isEditing && (
                  <div className="space-y-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">Question</label>
                      <input
                        type="text"
                        value={editQuestion}
                        onChange={e => setEditQuestion(e.target.value)}
                        className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </div>
                    <div className="flex flex-wrap gap-6">
                      <div>
                        <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Answer type</label>
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
                        <label className="mb-1 block text-xs font-medium text-muted-foreground">Points</label>
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
                        {editMutation.isPending ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Admin: set correct answer */}
                {user?.isAdmin && isSettingAnswer && !isEditing && (
                  <div className="space-y-2 pt-1 border-t">
                    <label className="text-xs font-medium text-muted-foreground">Correct answer</label>
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
                              {opt}
                            </button>
                          ))}
                        </div>
                      ) : q.answerType === 'player' ? (
                        <PlayerSearchInput
                          value={correctAnswerInput}
                          onChange={setCorrectAnswerInput}
                          placeholder="Search for the correct player…"
                        />
                      ) : q.answerType === 'team' ? (
                        <TeamSelectInput
                          value={correctAnswerInput}
                          onChange={setCorrectAnswerInput}
                          teams={teams}
                        />
                      ) : (
                        <input
                          type="number"
                          value={correctAnswerInput}
                          onChange={e => setCorrectAnswerInput(e.target.value)}
                          placeholder="Enter correct answer…"
                          className="w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        />
                      )}
                      <div className="flex gap-2">
                        <button
                          onClick={() => setAnswerMutation.mutate({ qid: q.id, correctAnswer: correctAnswerInput.trim() || null })}
                          disabled={setAnswerMutation.isPending}
                          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setSettingAnswerFor(null)}
                          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                        >
                          Cancel
                        </button>
                      </div>
                      {setAnswerError && <p className="text-xs text-destructive">{setAnswerError}</p>}
                    </div>
                  </div>
                )}

                {/* Admin: show stored correct answer (idle state) */}
                {user?.isAdmin && !isSettingAnswer && !isEditing && q.correctAnswer !== null && (
                  <CorrectAnswerDisplay type={q.answerType} value={q.correctAnswer} teams={teams} />
                )}

                {/* User: answer input */}
                {!user?.isAdmin && (
                  <div className="pt-1 border-t space-y-2">
                    {q.answerType === 'yes_no' ? (
                      <div className="flex items-center gap-3">
                        <div className="flex gap-2">
                          {(['Yes', 'No'] as const).map(opt => (
                            <button
                              key={opt}
                              type="button"
                              onClick={() => !deadlinePassed && handleYesNo(q.id, opt)}
                              disabled={deadlinePassed || saving}
                              className={`px-6 py-2 rounded-md border text-sm font-medium transition-colors disabled:cursor-not-allowed ${
                                localVal === opt
                                  ? 'bg-primary text-primary-foreground border-primary'
                                  : deadlinePassed
                                  ? 'opacity-50'
                                  : 'hover:bg-muted'
                              }`}
                            >
                              {opt}
                            </button>
                          ))}
                        </div>
                        {saving && <span className="text-xs text-muted-foreground">…</span>}
                        {justSaved && <span className="text-xs text-green-600">Saved!</span>}
                        {myAnswer?.points !== null && myAnswer?.points !== undefined && (
                          <span className="text-sm font-medium text-green-600">+{myAnswer.points} pts</span>
                        )}
                      </div>
                    ) : q.answerType === 'player' ? (
                      <>
                        <PlayerSearchInput
                          value={localVal}
                          onChange={val => setLocalAnswer(q.id, val)}
                          disabled={deadlinePassed}
                          placeholder={deadlinePassed ? (myAnswer?.answer || '—') : 'Search for a player…'}
                        />
                        <SaveRow
                          deadlinePassed={deadlinePassed}
                          hasValue={!!localVal.trim()}
                          saving={saving}
                          justSaved={justSaved}
                          points={myAnswer?.points ?? null}
                          onSave={() => saveAnswer(q.id)}
                        />
                      </>
                    ) : q.answerType === 'team' ? (
                      <>
                        {deadlinePassed ? (
                          <AnswerReadOnly type={q.answerType} value={myAnswer?.answer ?? ''} teams={teams} />
                        ) : (
                          <TeamSelectInput
                            value={localVal}
                            onChange={val => setLocalAnswer(q.id, val)}
                            teams={teams}
                          />
                        )}
                        {!deadlinePassed && (
                          <SaveRow
                            deadlinePassed={deadlinePassed}
                            hasValue={!!localVal.trim()}
                            saving={saving}
                            justSaved={justSaved}
                            points={myAnswer?.points ?? null}
                            onSave={() => saveAnswer(q.id)}
                          />
                        )}
                        {deadlinePassed && myAnswer?.points !== null && myAnswer?.points !== undefined && (
                          <span className="text-sm font-medium text-green-600">+{myAnswer.points} pts</span>
                        )}
                      </>
                    ) : (
                      /* number (and legacy text) */
                      <>
                        <input
                          type="number"
                          value={localVal}
                          onChange={e => setLocalAnswer(q.id, e.target.value)}
                          disabled={deadlinePassed}
                          placeholder={deadlinePassed ? (myAnswer?.answer ?? '—') : 'Your answer…'}
                          className="w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:bg-muted disabled:text-muted-foreground [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        />
                        <SaveRow
                          deadlinePassed={deadlinePassed}
                          hasValue={!!localVal.trim()}
                          saving={saving}
                          justSaved={justSaved}
                          points={myAnswer?.points ?? null}
                          onSave={() => saveAnswer(q.id)}
                        />
                      </>
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

// ── Small helpers ─────────────────────────────────────────────────────────────

function SaveRow({
  deadlinePassed, hasValue, saving, justSaved, points, onSave,
}: {
  deadlinePassed: boolean;
  hasValue: boolean;
  saving: boolean;
  justSaved: boolean;
  points: number | null;
  onSave: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      {!deadlinePassed && (
        <button
          onClick={onSave}
          disabled={saving || !hasValue}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? '…' : justSaved ? 'Saved!' : 'Save'}
        </button>
      )}
      {points !== null && points !== undefined && (
        <span className="text-sm font-medium text-green-600">+{points} pts</span>
      )}
    </div>
  );
}

function CorrectAnswerDisplay({ type, value, teams }: { type: BonusAnswerType | string; value: string; teams: Team[] }) {
  const teamObj = type === 'team' ? teams.find(t => t.name === value) : null;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground border-t pt-2">
      <span>Correct answer:</span>
      {teamObj?.imageUrl && (
        <img src={teamObj.imageUrl} alt="" className="h-4 w-4 rounded-full object-cover" />
      )}
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

function AnswerReadOnly({ type, value, teams }: { type: BonusAnswerType | string; value: string; teams: Team[] }) {
  if (!value) return <p className="text-sm text-muted-foreground">No answer submitted</p>;
  const teamObj = type === 'team' ? teams.find(t => t.name === value) : null;
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2">
      {teamObj?.imageUrl && (
        <img src={teamObj.imageUrl} alt="" className="h-5 w-5 rounded-full object-cover flex-shrink-0" />
      )}
      <span className="text-sm text-muted-foreground">{value}</span>
    </div>
  );
}
